// Cloudflare Pages Functions 共享模块
// 案件数据内嵌（Workers 无文件系统）

import manor from '../../cases/manor.json';
import station from '../../cases/station.json';
import magic from '../../cases/magic.json';
import nightclub from '../../cases/nightclub.json';

const CASES = { manor, station, magic, nightclub };

export function loadCase(caseId) {
  const c = CASES[caseId];
  if (!c) throw new Error(`未知案件: ${caseId}`);
  return c;
}

// 脱敏：只下发玩家可见数据（真相/秘密/谎言永不下发）
export function publicCase(caseData, mode = 'normal') {
  const hm = mode === 'hard' ? caseData.hard_mode : null;
  const keySet = hm ? new Set(hm.key_clues) : null;
  const overrides = hm ? (hm.clue_overrides || {}) : {};
  const clues = caseData.clues.map(c => {
    const o = overrides[c.id] || {};
    return {
      id: c.id,
      title: (o.title || c.title),
      desc: (o.desc || c.desc),
      is_key: keySet ? keySet.has(c.id) : !!c.is_key,
    };
  });
  const suspects = caseData.suspects.map(s => ({
    id: s.id,
    name: s.name,
    role: s.role,
    avatar: s.avatar || '',
    bio: s.bio || '',
    suggested_questions: s.suggested_questions || [],
  }));
  return {
    id: caseData.id,
    title: caseData.title,
    era: caseData.era,
    intro: caseData.intro,
    scene: caseData.scene || '',
    suspects,
    clues,
    victim: caseData.victim || '',
  };
}

// 审问 system prompt（LLM 扮演嫌疑人）
export function buildSystemPrompt(caseData, suspect, mode = 'normal') {
  const hm = mode === 'hard' ? caseData.hard_mode : null;
  const secrets = suspect.secrets || [];
  const lies = suspect.lies || [];
  const clueTexts = caseData.clues.map(c => {
    const overrides = hm ? ((hm.clue_overrides || {})[c.id] || {}) : {};
    return `- ${c.id}「${overrides.title || c.title}」: ${overrides.desc || c.desc}`;
  }).join('\n');
  const suspectLines = caseData.suspects.map(s => `- ${s.id}（${s.name}, ${s.role}）`).join('\n');

  let lieBlock = lies.length
    ? `你撒的谎（绝不能承认，除非被铁证揭穿）:\n${lies.map(l => `- ${l}`).join('\n')}`
    : '你基本诚实，但有所隐瞒。';
  if (hm) {
    const hardLies = (hm.suspect_lie_overrides || {})[suspect.id] || [];
    if (hardLies.length) {
      lieBlock = `你撒的谎（绝不能承认，除非被铁证揭穿）:\n${hardLies.map(l => `- ${l}`).join('\n')}`;
    }
  }

  return `你是「${caseData.title}」中的角色 ${suspect.name}（${suspect.role}），正在接受侦探（玩家）的审问。

【案件背景】
${caseData.intro}

【全部涉案人员】
${suspectLines}

【你的秘密（绝不能主动说出）】
${secrets.map(s => `- ${s}`).join('\n')}

【你的谎言】
${lieBlock}

【案件线索表（玩家可能已掌握，你不知对方知道多少）】
${clueTexts}

【扮演规则】
1. 你是一个有血有肉的嫌疑人，有情绪、有戒备心。用第一人称说话。
2. 回答要口语化、自然，像真实对话，长度不超过30字。可以用"嗯…""这个…"等口头语，偶尔简短。
3. 你在撒谎时会有细微破绽（支吾、转移话题、反问），但绝不主动承认。
4. 玩家问到的内容如果涉及你的秘密或谎言，你试图回避或编造，但不要编造案件没有的事实。
5. 除非玩家直接说出对应线索的关键细节（例如"有人看到你进了书房"），你才被迫承认或解释。
6. 绝不透露"我是凶手"或任何直接定罪的话。
7. 用中文回答。`;
}

// LLM 返回 JSON 解析容错
export function parseLlmJson(text) {
  if (!text) return {};
  const t = text.trim();
  try { return JSON.parse(t); } catch (_) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  return {};
}

// 环境变量
export function getEnv(env) {
  return {
    baseUrl: env.LM_BASE_URL || 'http://localhost:1234/v1',
    model: env.LM_MODEL || 'qwen/qwen3.6-35b-a3b',
    apiKey: env.LM_API_KEY || '',
  };
}

// 统一 CORS 头
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function corsJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}
