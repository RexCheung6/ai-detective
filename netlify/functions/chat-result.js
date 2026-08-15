// GET /api/chat/result?task=xxx — 轮询读取后台任务结果
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'aid-chat-results';

export default async (req) => {
  const url = new URL(req.url);
  const taskId = url.searchParams.get('task');
  if (!taskId) {
    return new Response(JSON.stringify({ error: 'missing task' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const store = getStore({ name: STORE_NAME });
    const raw = await store.get(taskId);
    if (!raw) {
      return new Response(JSON.stringify({ status: 'pending' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const data = JSON.parse(raw);
    // 读取后删除，节省 Blobs 空间
    await store.delete(taskId);
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ status: 'error', error: String(e.message || e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/chat/result' };
