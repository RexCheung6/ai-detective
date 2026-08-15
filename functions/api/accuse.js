// POST /api/accuse — 指控裁决（服务端，mode=hard 用反转真相）
import { loadCase, corsJson, corsPreflight } from './_shared.js';

export const onRequest = async ({ request }) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  try {
    const body = await request.json();
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

    return corsJson({
      result,
      truth: (result === 'convicted' || result === 'wrong') ? truth : null,
    });
  } catch (e) {
    return corsJson({ error: String(e.message || e) }, 500);
  }
};
