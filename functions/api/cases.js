// GET /api/cases — 案件列表
import { corsJson, corsPreflight } from './_shared.js';
import manor from '../../cases/manor.json';
import station from '../../cases/station.json';
import magic from '../../cases/magic.json';
import nightclub from '../../cases/nightclub.json';

export const onRequest = async ({ request }) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  const list = [manor, station, magic, nightclub].map(c => ({
    id: c.id, title: c.title, era: c.era, intro: (c.intro || '').slice(0, 80),
  }));
  return corsJson(list);
};
