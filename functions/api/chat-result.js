// GET /api/chat/result?task=xxx — 轮询读取 KV 结果
import { corsJson, corsPreflight } from './_shared.js';

export const onRequest = async ({ request, env }) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  const url = new URL(request.url);
  const taskId = url.searchParams.get('task');
  if (!taskId) return corsJson({ error: 'missing task' }, 400);
  try {
    const raw = await env.AID_CHAT_RESULTS.get(taskId);
    if (!raw) return corsJson({ status: 'pending' });
    // 读取后删除
    await env.AID_CHAT_RESULTS.delete(taskId);
    return corsJson(JSON.parse(raw));
  } catch (e) {
    return corsJson({ status: 'error', error: String(e.message || e) }, 500);
  }
};
