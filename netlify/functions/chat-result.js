// GET /api/chat/result?task=xxx — 轮询读取后台任务结果
import { getStore } from '@netlify/blobs';
import { corsJson, corsPreflight } from './lib/shared.js';

const STORE_NAME = 'aid-chat-results';

export default async (req) => {
  if (req.method === 'OPTIONS') return corsPreflight();
  const url = new URL(req.url);
  const taskId = url.searchParams.get('task');
  if (!taskId) {
    return corsJson({ error: 'missing task' }, 400);
  }
  try {
    const store = getStore({ name: STORE_NAME });
    const raw = await store.get(taskId);
    if (!raw) {
      return corsJson({ status: 'pending' });
    }
    const data = JSON.parse(raw);
    // 读取后删除，节省 Blobs 空间
    await store.delete(taskId);
    return corsJson(data);
  } catch (e) {
    return corsJson({ status: 'error', error: String(e.message || e) }, 500);
  }
};

export const config = { path: '/api/chat/result' };
