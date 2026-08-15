// POST /api/chat — 异步审问：立即 202，waitUntil 后台调本地 LM Studio（经隧道），结果存 KV
import { loadCase, buildSystemPrompt, parseLlmJson, getEnv, corsJson, corsPreflight } from './_shared.js';

// 关键词触发规则（与案件 JSON 一致，服务端判定）
function checkKeywordTriggers(caseData, question) {
  const hits = [];
  for (const clue of caseData.clues) {
    const kws = clue.trigger_keywords || [];
    if (!kws.length) continue;
    for (const kw of kws) {
      if (question.includes(kw)) { hits.push({ id: clue.id, title: clue.title }); break; }
    }
  }
  return hits;
}

async function runChatTask(body, taskId, env, ctx) {
  try {
    const caseData = loadCase(body.case_id);
    const suspect = caseData.suspects.find(s => s.id === body.suspect_id);
    if (!suspect) {
      await env.AID_CHAT_RESULTS.put(taskId, JSON.stringify({ status: 'error', error: '嫌疑人不存在' }));
      return;
    }

    // 关键词触发（服务端判定）
    const mode = body.mode || 'normal';
    const hm = mode === 'hard' ? caseData.hard_mode : null;
    const keySet = hm ? new Set(hm.key_clues) : null;
    const triggered = checkKeywordTriggers(caseData, body.question || '');
    const newClues = [];
    const owned = new Set(body.owned_clues || []);
    for (const t of triggered) {
      if (owned.has(t.id)) continue;
      const isKey = keySet ? keySet.has(t.id) : !!caseData.clues.find(c => c.id === t.id)?.is_key;
      newClues.push({ id: t.id, title: t.title, is_key: isKey });
    }

    // 组装消息
    const system = buildSystemPrompt(caseData, suspect, mode);
    const messages = [{ role: 'system', content: system }];
    const hist = Array.isArray(body.history) ? body.history.slice(-8) : [];
    for (const h of hist) {
      // 兼容两种格式：前端 {role,content} 与旧 {q,a}
      if (h && h.content !== undefined) {
        if (h.content) messages.push({ role: h.role || 'user', content: h.content });
      } else {
        if (h && h.q) messages.push({ role: 'user', content: h.q });
        if (h && h.a) messages.push({ role: 'assistant', content: h.a });
      }
    }
    messages.push({ role: 'user', content: body.question || '' });

    // 调用本地模型（经隧道）
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
    });

    if (!llmResp.ok) {
      const errText = await llmResp.text().catch(() => '');
      await env.AID_CHAT_RESULTS.put(taskId, JSON.stringify({
        status: 'error',
        error: `LLM HTTP ${llmResp.status}: ${errText.slice(0, 300)}`,
        ts: Date.now(),
      }));
      return;
    }

    const data = await llmResp.json();
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';

    await env.AID_CHAT_RESULTS.put(taskId, JSON.stringify({
      status: 'done',
      reply: reply,
      new_clues: newClues,
      backend: '本地 LM Studio',
      ts: Date.now(),
    }));
  } catch (e) {
    await env.AID_CHAT_RESULTS.put(taskId, JSON.stringify({
      status: 'error', error: String(e.message || e), ts: Date.now(),
    }));
  }
}

export const onRequest = async ({ request, env, waitUntil }) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  let body = {};
  let taskId = null;
  try {
    body = await request.json();
  } catch (_) {}
  taskId = body.task_id || `t${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // waitUntil 后台执行（Cloudflare 同步限制 30s，异步跑 LLM）
  waitUntil(runChatTask(body, taskId, env));
  return corsJson({ task_id: taskId }, 202);
};
