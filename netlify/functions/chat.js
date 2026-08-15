// POST /api/chat — Background Function：接收审问请求，立即 202，
// 后台调用本地 LM Studio（经隧道），结果存 Netlify Blobs（key = task_id）
import { getStore } from '@netlify/blobs';
import { loadCase, buildSystemPrompt, parseLlmJson, getEnv } from './lib/shared.js';

const STORE_NAME = 'aid-chat-results';

async function callLlm(system, history, userMsg) {
  const { baseUrl, model, apiKey } = getEnv();
  const messages = [{ role: 'system', content: system }];
  messages.push(...history.slice(-16));
  messages.push({ role: 'user', content: userMsg });

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.8,
      max_tokens: 4000,
      stream: false,
      think: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error('empty LLM output');
  return content;
}

// 后台任务：调用 LLM + 关键词触发 + 结果存 Blobs
async function runChatTask(body, taskId) {
  const store = getStore({ name: STORE_NAME });
  try {
    // 自检：立即写入一个 started 标记，验证 Blobs 可写
    await store.set(`${taskId}_started`, JSON.stringify({ ts: Date.now(), hasBody: !!body }));
    const caseData = loadCase(body.case_id);
    const suspect = caseData.suspects.find(s => s.id === body.suspect_id);
    if (!suspect) throw new Error(`suspect ${body.suspect_id} not found`);
    const mode = body.mode || 'normal';
    const system = buildSystemPrompt(caseData, suspect, mode);
    const history = Array.isArray(body.history) ? body.history : [];
    const question = body.question || '';

    // 重试最多 4 次（应对偶发空回复）
    let parsed = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const raw = await callLlm(system, history, question);
        parsed = parseLlmJson(raw);
        if (!parsed.reply || !String(parsed.reply).trim()) throw new Error('empty reply');
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!parsed) throw lastErr || new Error('LLM 调用失败');

    // 线索校验（ID 或标题容错）
    const validClues = new Set(suspect.clues_available || []);
    const titleToId = {};
    caseData.clues.forEach(c => { titleToId[c.title] = c.id; });
    const revealed = [];
    for (const c of parsed.reveals_clue || []) {
      const cid = validClues.has(c) ? c : titleToId[c];
      if (cid && !revealed.includes(cid)) revealed.push(cid);
    }
    // 关键词规则触发（限流 2 条）
    const text = `${question} ${parsed.reply}`;
    for (const c of caseData.clues) {
      if (revealed.length >= 2) break;
      if (!validClues.has(c.id) || revealed.includes(c.id)) continue;
      const kws = c.trigger_keywords || [];
      if (kws.some(kw => text.includes(kw))) revealed.push(c.id);
    }
    const owned = new Set(body.owned_clues || []);
    const newClues = revealed.filter(c => !owned.has(c));
    const clueDetails = caseData.clues
      .filter(c => newClues.includes(c.id))
      .map(({ trigger_keywords, ...rest }) => rest);

    await store.set(taskId, JSON.stringify({
      status: 'done',
      reply: parsed.reply,
      mood: parsed.mood || 'calm',
      new_clues: clueDetails,
      backend: '本地 LM Studio',
      ts: Date.now(),
    }));
  } catch (e) {
    await store.set(taskId, JSON.stringify({
      status: 'error',
      error: String(e.message || e),
      ts: Date.now(),
    }));
  }
}

export default async (req) => {
  let body = null;
  let taskId = null;
  try {
    body = await req.json();
    taskId = body.task_id || `t${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  } catch (e) {
    body = body || {};
    taskId = taskId || `t${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  // 决定性测试：在 handler 内 await 写入 started 标记（若成功说明 Blobs 在 background 下可用）
  try {
    await getStore({ name: STORE_NAME }).set(`${taskId}_handler`, JSON.stringify({ ts: Date.now(), hasBody: !!body, bodyKeys: Object.keys(body) }));
  } catch (e) {
    try {
      await getStore({ name: STORE_NAME }).set(`${taskId}_handler`, JSON.stringify({ error: String(e), ts: Date.now() }));
    } catch (_) {}
  }
  // 触发后台任务（不等待）
  runChatTask(body, taskId).catch(e => {
    try {
      getStore({ name: STORE_NAME }).set(taskId, JSON.stringify({ status: 'error', error: String(e), ts: Date.now() }));
    } catch (_) {}
  });
  return new Response(JSON.stringify({ task_id: taskId }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { background: true };
