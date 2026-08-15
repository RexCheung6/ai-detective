// GET /api/case?id=xxx&mode=normal|hard — 脱敏案件数据
import { loadCase, publicCase, corsJson, corsPreflight } from './_shared.js';

export const onRequest = async ({ request }) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || 'manor';
  const mode = url.searchParams.get('mode') || 'normal';
  try {
    return corsJson(publicCase(loadCase(id), mode));
  } catch (e) {
    return corsJson({ error: e.message }, 404);
  }
};
