// POST /api/accuse — 指控裁决（服务端，mode=hard 用反转真相）
import { loadCase } from './lib/shared.js';

export default async (req) => {
  try {
    const body = await req.json();
    const caseData = loadCase(body.case_id);
    const suspectId = body.suspect_id;
    const evidenceIds = new Set(body.evidence_ids || []);
    const mode = body.mode || 'normal';

    const hm = mode === 'hard' ? caseData.hard_mode : null;
    const truth = hm ? hm.truth : caseData.truth;
    const keySet = hm ? new Set(hm.key_clues) : null;

    const correct = suspectId === truth.killer;
    const keyEvidenceHeld = caseData.clues.some(c =>
      evidenceIds.has(c.id) && (keySet ? keySet.has(c.id) : !!c.is_key)
    );

    let result;
    if (correct && keyEvidenceHeld) result = 'convicted';
    else if (correct) result = 'insufficient';
    else result = 'wrong';

    return new Response(JSON.stringify({
      result,
      truth: (result === 'convicted' || result === 'wrong') ? truth : null,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/accuse' };
