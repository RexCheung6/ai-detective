// POST /api/chat — 同步审问（本地模型响应 15-50s，等待网络 I/O 不占 Workers CPU 配额）
// 说明：Cloudflare Workers 的 30s 限制是 CPU 时间；fetch 隧道等待不消耗 CPU，
//       因此同步等待完全可行。比 waitUntil+KV+轮询 简单且不会 30s 后台被掐断。
import { loadCase, buildSystemPrompt, parseLlmJson, getEnv, corsJson, corsPreflight } from './_shared.js';

// 关键词触发规则（与案件 JSON 一致，服务端判定；一次最多 2 条防刷）
function checkKeywordTriggers(caseData, question, reply, owned) {
  const hits = [];
  const text = (question || '') + ' ' + (reply || '');
  for (const clue of caseData.clues) {
    if (hits.length >= 2) break;
    const kws = clue.trigger_keywords || [];
    if (!kws.length) continue;
    if (owned.has(clue.id)) continue;
    for (const kw of kws) {
      if (text.includes(kw)) { hits.push({ id: clue.id, title: clue.title }); break; }
    }
  }
  return hits;
}

export const onRequest = async ({ request, env }) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  let body = {};
  try {
    body = await request.json();
  } catch (_) {}

  try {
    const caseData = loadCase(body.case_id);
    const suspect = caseData.suspects.find(s => s.id === body.suspect_id);
    if (!suspect) {
      return corsJson({ error: '嫌疑人不存在' }, 404);
    }

    // 关键词触发（服务端判定，含 LLM 回复内容）
    const mode = body.mode || 'normal';
    const owned = new Set(body.owned_clues || []);
    const hm = mode === 'hard' ? caseData.hard_mode : null;
    const keySet = hm ? new Set(hm.key_clues) : null;

    // 组装消息（兼容前端 {role,content} 与旧 {q,a} 两种历史格式）
    const system = buildSystemPrompt(caseData, suspect, mode);
    const messages = [{ role: 'system', content: system }];
    const hist = Array.isArray(body.history) ? body.history.slice(-8) : [];
    for (const h of hist) {
      if (h && h.content !== undefined) {
        if (h.content) messages.push({ role: h.role || 'user', content: h.content });
      } else {
        if (h && h.q) messages.push({ role: 'user', content: h.q });
        if (h && h.a) messages.push({ role: 'assistant', content: h.a });
      }
    }
    messages.push({ role: 'user', content: body.question || '' });

    // 调用本地模型（经隧道）；AbortSignal.timeout 120s 覆盖模型最慢响应
    const envCfg = getEnv(env);
    const llmResp = await fetch(envCfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + envCfg.apiKey,
      },
      body: JSON.stringify({
        model: envCfg.model,
        messages,
        temperature: 0.8,
        max_tokens: 4000,
        stream: false,
        think: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!llmResp.ok) {
      const errText = await llmResp.text().catch(() => '');
      return corsJson({ error: `LLM HTTP ${llmResp.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const data = await llmResp.json();
    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const parsed = parseLlmJson(raw);

    // 校验揭示的线索属于该嫌疑人（容错：模型可能返回 ID 或标题）
    const validClues = new Set(suspect.clues_available || []);
    const clueTitleToId = {};
    for (const c of caseData.clues) clueTitleToId[c.title] = c.id;
    const revealed = [];
    const rawReveals = Array.isArray(parsed.reveals_clue) ? parsed.reveals_clue : [];
    for (const r of rawReveals) {
      const cid = validClues.has(r) ? r : (clueTitleToId[r] || null);
      if (cid && !revealed.includes(cid)) revealed.push(cid);
    }
    // 关键词规则兜底（100% 可靠），最多 2 条
    const triggered = checkKeywordTriggers(caseData, body.question, parsed.reply, owned);
    for (const t of triggered) {
      if (!revealed.includes(t.id)) revealed.push(t.id);
      if (revealed.length >= 2) break;
    }

    // 只返回玩家尚未拥有的新线索（含 is_key 标记与详情）
    const newClues = [];
    for (const cid of revealed) {
      if (owned.has(cid)) continue;
      const clue = caseData.clues.find(c => c.id === cid);
      if (!clue) continue;
      newClues.push({
        id: clue.id,
        title: clue.title,
        desc: clue.desc,
        source: clue.source || '',
        is_key: keySet ? keySet.has(clue.id) : !!clue.is_key,
      });
    }

    return corsJson({
      reply: parsed.reply || '……',
      mood: parsed.mood || 'calm',
      new_clues: newClues,
      backend: '本地 LM Studio',
    });
  } catch (e) {
    return corsJson({ error: String(e.message || e) }, 500);
  }
};
