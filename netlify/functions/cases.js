// GET /api/cases — 案件列表（仅元信息）
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { corsJson, corsPreflight } from './lib/shared.js';

const CASES_DIR = join(new URL('.', import.meta.url).pathname, 'cases');

export default async (req) => {
  if (req.method === 'OPTIONS') return corsPreflight();
  const list = [];
  if (existsSync(CASES_DIR)) {
    for (const f of readdirSync(CASES_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf-8'));
        list.push({ id: c.id, title: c.title, era: c.era, intro: (c.intro || '').slice(0, 80) });
      } catch (e) { /* skip broken */ }
    }
  }
  return corsJson(list);
};

export const config = { path: '/api/cases' };
