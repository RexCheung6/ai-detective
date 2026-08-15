// GET /api/case?id=xxx&mode=normal|hard — 脱敏案件数据
import { loadCase, publicCase, corsJson, corsPreflight } from './lib/shared.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return corsPreflight();
  const url = new URL(req.url);
  const id = url.searchParams.get('id') || 'manor';
  const mode = url.searchParams.get('mode') || 'normal';
  try {
    const data = publicCase(loadCase(id), mode);
    return corsJson(data);
  } catch (e) {
    return corsJson({ error: e.message }, 404);
  }
};

export const config = { path: '/api/case' };
