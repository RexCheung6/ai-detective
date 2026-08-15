// GET /api/case?id=xxx&mode=normal|hard — 脱敏案件数据
import { loadCase, publicCase } from './lib/shared.js';

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id') || 'manor';
  const mode = url.searchParams.get('mode') || 'normal';
  try {
    const data = publicCase(loadCase(id), mode);
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/case' };
