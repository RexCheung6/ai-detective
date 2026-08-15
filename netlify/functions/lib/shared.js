// 共享模块：案件加载、脱敏、prompt 组装（从 server.py 移植）
// 案件 JSON 部署在同目录 cases/ 下

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Netlify v2 Functions 是 ESM：用 import.meta.url 定位（避免 __dirname 冲突）
const CASES_DIR = join(new URL('.', import.meta.url).pathname, 'cases');

export function loadCase(caseId) {
  const path = join(CASES_DIR, `${caseId}.json`);
  if (!existsSync(path)) throw new Error(`case ${caseId} not found`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function publicCase(caseData, mode = 'normal') {
  const hm = mode === 'hard' ? caseData.hard_mode : null;
  const keySet = hm ? new Set(hm.key_clues) : null;
  const overrides = hm ? (hm.clue_overrides || {}) : {};
  return {
    id: caseData.id,
    title: caseData.title,
    era: caseData.era,
    intro: caseData.intro,
    scene: caseData.scene,
    time_limit_hint: caseData.time_limit_hint || '',
    suspects: caseData.suspects.map(s => ({
      id: s.id, name: s.name, role: s.role, emoji: s.emoji, age: s.age,
      appearance: s.appearance, personality: s.personality,
      opening_line: s.opening_line, clues_available: s.clues_available,
      suggested_questions: s.suggested_questions || [],
    })),
    clues: caseData.clues.map(c => ({
      id: c.id, title: c.title,
      desc: overrides[c.id] || c.desc,
      source: c.source,
      is_key: keySet ? keySet.has(c.id) : !!c.is_key,
    })),
  };
}

export function buildSystemPrompt(caseData, suspect, mode = 'normal') {
  const liesText = suspect.lies.map(l =>
    `- 话题「${l.topic}」：你必须撒谎说「${l.lie}」。真相是「${l.truth}」，但绝不能承认。`
  ).join('\n');

  let hmExtra = '';
  if (mode === 'hard') {
    const extra = (caseData.hard_mode?.suspect_extra || {})[suspect.id];
    if (extra) hmExtra = `\n\n【困难模式·本案件特殊设定（必须遵守）】\n${extra}`;
  }

  const cluesText = caseData.clues
    .filter(c => (suspect.clues_available || []).includes(c.id))
    .map(c => `- ${c.title}：${c.desc}`).join('\n');

  return `你正在扮演一名角色扮演游戏中的嫌疑人。你是「${suspect.name}」，${suspect.role}，${suspect.age}岁。
性格：${suspect.personality}
说话风格：${suspect.speech || '正常说话'}

案件背景：
${caseData.intro}
案发现场：${caseData.scene}
${caseData.time_limit_hint || ''}

你的角色秘密（绝对不能承认，被追问时要转移话题或反问）：
${suspect.secret}

你必须遵守的谎言（玩家问到相关话题时，必须按谎言回答，永远不能透露真相）：
${liesText}

你的作案动机（你本人可能是清白的，但动机要合理）：
${suspect.motive}
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
${cluesText}

输出格式（严格 JSON，不要输出其他任何内容）：
{"reply": "你的回答", "mood": "calm|nervous|angry|evasive|sad", "reveals_clue": ["线索ID数组，没有则[]"]}`;
}

export function parseLlmJson(text) {
  text = String(text || '').trim();
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) text = codeBlock[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`no JSON object in LLM output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

export function getEnv() {
  return {
    baseUrl: process.env.LM_BASE_URL || 'http://localhost:1234/v1',
    model: process.env.LM_MODEL || 'qwen/qwen3.6-35b-a3b',
    apiKey: process.env.LM_API_KEY || '',
  };
}
