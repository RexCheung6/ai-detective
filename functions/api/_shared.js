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
      source: c.source || '',
      is_key: keySet ? keySet.has(c.id) : !!c.is_key,
    };
  });
  const suspects = caseData.suspects.map(s => ({
    id: s.id,
    name: s.name,
    role: s.role,
    emoji: s.emoji || '🧑',
    age: s.age || '',
    appearance: s.appearance || '',
    personality: s.personality || '',
    opening_line: s.opening_line || '',
    background: s.background || '',    // 背景故事/与死者关系（开局可见，可引导可误导，动机留给玩家猜）
    clues_available: s.clues_available || [],
    suggested_questions: s.suggested_questions || [],
  }));
  return {
    id: caseData.id,
    title: caseData.title,
    era: caseData.era,
    intro: caseData.intro,
    scene: caseData.scene || '',
    time_limit_hint: caseData.time_limit_hint || '',
    suspects,
    clues,
    victim: caseData.victim || '',
  };
}

// 审问 system prompt（LLM 扮演嫌疑人）
// ⚠️ 必须与 server.py build_system_prompt 保持行为一致（双后端对拍）
// 案件 JSON 字段：secret(单数，字符串) / lies(对象数组 {topic,lie,truth}) / motive / clues_available
export function buildSystemPrompt(caseData, suspect, mode = 'normal') {
  const hm = mode === 'hard' ? caseData.hard_mode : null;

  // 秘密：JSON 字段是单数 secret（字符串）
  const secretText = suspect.secret || suspect.secrets || '';

  // 谎言：对象数组 {topic, lie, truth}，正确格式化
  const lies = Array.isArray(suspect.lies) ? suspect.lies : [];
  let lieBlock = lies.length
    ? lies.map(l => `- 话题「${l.topic}」：你必须撒谎说「${l.lie}」。真相是「${l.truth}」，但绝不能承认。`).join('\n')
    : '你基本诚实，但有所隐瞒。';
  // 困难模式：覆盖该嫌疑人的谎言
  if (hm) {
    const hardLies = (hm.suspect_lie_overrides || {})[suspect.id] || [];
    if (hardLies.length) {
      lieBlock = `- ${hardLies.join('\n- ')}`;
    }
  }

  // 困难模式：注入反转真相提示
  let hmExtra = '';
  if (hm) {
    const extra = (hm.suspect_extra || {})[suspect.id] || '';
    if (extra) hmExtra = `\n\n【困难模式·本案件特殊设定（必须遵守）】\n${extra}`;
  }

  // 线索：只注入当前嫌疑人 clues_available 的线索（防全量泄漏），并应用困难模式覆盖
  const available = new Set(suspect.clues_available || []);
  const clueTexts = caseData.clues
    .filter(c => available.has(c.id))
    .map(c => {
      const o = hm ? ((hm.clue_overrides || {})[c.id] || {}) : {};
      return `- ${o.title || c.title}：${o.desc || c.desc}`;
    })
    .join('\n');

  const suspectLines = caseData.suspects.map(s => `- ${s.id}（${s.name}, ${s.role}）`).join('\n');

  return `你正在扮演一名角色扮演游戏中的嫌疑人。你是「${suspect.name}」，${suspect.role}，${suspect.age || '?'}岁。
外貌：${suspect.appearance || ''}
性格：${suspect.personality || ''}
说话风格：${suspect.speech || ''}

案件背景：
${caseData.intro}
案发现场：${caseData.scene || ''}
${caseData.time_limit_hint || ''}

你的角色秘密（绝对不能承认，被追问时要转移话题或反问）：
${secretText}

你必须遵守的谎言（玩家问到相关话题时，必须按谎言回答，永远不能透露真相）：
${lieBlock}

你的作案动机（你本人可能是清白的，但动机要合理）：
${suspect.motive || ''}
${hmExtra}
角色行为准则：
1. 用第一人称、口语化回答，符合你的性格和说话风格。**每轮只回答 1-2 句话（30字以内），绝不长篇大论。**
2. 你是嫌疑人，不是侦探——永远不要主动说"我是凶手"或"某某是凶手"。
3. 被问到你撒谎的话题时，按谎言回答，被追问得紧就紧张、回避、反问。
4. 玩家展示证据或戳破你谎言时，你会慌乱/愤怒/沉默。

线索揭示规则（重要，行动点有限，线索必须珍贵）：
- 你拥有以下可揭示的线索。**只有当玩家的问题直接击中关键点（明确问到相关细节）时**，才把线索 id 填入 reveals_clue。
- 泛泛的问题（"你在哪""你看到了什么"）不会触发线索——玩家必须追问具体细节才会松口。
- 每次回答最多揭示 1 条新线索，不要把全部线索一口气倒出来。
- 线索在回答正文中自然带出（比如提到"我当时看到/听到/知道……"），同时把 id 写进 reveals_clue。

可揭示线索：
${clueTexts || '（无）'}

【全部涉案人员】
${suspectLines}

输出格式（严格 JSON，不要输出其他任何内容）：
{"reply": "你的回答", "mood": "calm|nervous|angry|evasive|sad", "reveals_clue": ["线索ID数组，没有则[]"]}`;
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
