# AI 侦探 · 交互推理游戏

> **AI Detective** — 嫌疑人由你的本地大模型实时扮演的交互推理游戏。
> 玩家选择案件 → 审问嫌疑人（LLM 实时角色扮演）→ 收集线索（行动点限制）→ 指控凶手（服务端裁决）。

![版本](https://img.shields.io/badge/版本-V1.0%20Cornerstone-8A2BE2) ![架构](https://img.shields.io/badge/前端-HTML%2FCSS%2FJS-blue) ![后端](https://img.shields.io/badge/后端-Cloudflare%20Pages%20Functions-orange) ![LLM](https://img.shields.io/badge/LLM-本地LM%20Studio-green) ![打包](https://img.shields.io/badge/打包-Electron%20%2B%20Capacitor-purple)

> 📌 **本文档版本：V1.0（Cornerstone）** — 记录 2026-08-16 时的架构与代码实现。
>
> **文档维护约定**：
> - 本文档描述的架构/代码以 **V1.0** 为基准快照，**后续版本更新时不要修改 1.0 章节内容**；
> - 新版本上线后，在文末【版本历史】追加新版本章节，只记录**相对当前版本的变化部分**；
> - 若某章节已随版本变化过时，在该章节顶部加一行 `> ⚠️ 本章节描述 V1.0 实现，V2.0 起已变更（见版本历史）`，而非改写原内容。

---

## 目录

- [一、项目概览](#一项目概览)
- [二、总体架构](#二总体架构)
- [三、目录结构](#三目录结构)
- [四、前端（public/index.html）](#四前端publicindexhtml)
- [五、后端（Cloudflare Pages Functions）](#五后端cloudflare-pages-functions)
- [六、案件数据模型（cases/*.json）](#六案件数据模型casesjson)
- [七、LLM 推理链路](#七llm-推理链路)
- [八、本地开发后端（server.py）](#八本地开发后端serverpy)
- [九、隧道与守护（cloudflared + launchd）](#九隧道与守护cloudflared--launchd)
- [十、部署（Cloudflare Pages + wrangler）](#十部署cloudflare-pages--wrangler)
- [十一、测试服（staging）与发布流程](#十一测试服staging与发布流程)
- [十二、用户系统与进度保存](#十二用户系统与进度保存)
- [十三、常见问题与排障](#十三常见问题与排障)
- [十四、开发约定与安全红线](#十四开发约定与安全红线)
- [附：技术栈速查](#附技术栈速查)
- [附：版本历史](#附版本历史)

---

## 一、项目概览

一款**中文手机优先**的暗色侦探推理游戏。核心卖点：

- **LLM 实时角色扮演**：每个嫌疑人由本地大模型（LM Studio）扮演，玩家用自然语言自由审问
- **案件真相写死在服务端**：LLM 只负责"表演"，不负责"创作事实"——真相、秘密、谎言全部预设在案件 JSON 中
- **行动点系统**：每案 10 点，提问 -1、指控 -2，用尽必须指控（限制模型调用次数、增加策略性）
- **关键词线索触发**：不依赖 LLM 自觉，玩家问中关键词即 100% 触发线索
- **服务端指控裁决**：凶手正确 + 持有 ≥1 条关键证据 = 定罪成功
- **普通/困难双模式**：困难模式真凶与关键证据完全反转

**核心价值**：免费玩（本地模型）、可离线创作案件（纯 JSON）、已发布三平台安装包（Windows/macOS/Android）。

---

## 二、总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        玩家（手机 / 电脑）                         │
│             网页版 pages.dev  /  Electron  /  Capacitor          │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS /api/*（前端零密钥、零公网地址硬编码）
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Cloudflare Pages（生产后端，免费）                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Pages Functions（/api/*）                                    │  │
│  │  cases / case / chat / accuse                              │  │
│  │  chat 同步执行：组装 prompt → 隧道 → 本地 LM Studio 直接返回 │  │
│  └──────────────┬─────────────────────────────────────────────┘  │
│                 │ 环境变量 LM_BASE_URL / LM_API_KEY / LM_MODEL    │
│                 ▼                                                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS（Cloudflare Tunnel，免费）
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   你的 Mac（本机）                                 │
│  ┌─────────────────────────────┐    ┌─────────────────────────┐ │
│  │ cloudflared 隧道（launchd）   │    │ LM Studio（localhost:1234）│ │
│  │ 守护：崩溃自启/URL变化自动同步  │◄───│ qwen3.6-35b-a3b (MoE)   │ │
│  └─────────────────────────────┘    └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**关键设计决策**：

| 决策 | 原因 |
|------|------|
| LLM 不创作事实 | 防止模型自由发挥导致案情矛盾/泄底；所有剧情内容服务端 JSON 预置 |
| 前端零密钥 | 密钥只在服务端（Cloudflare secret）与本地隧道；玩家无法提取 |
| chat 同步化 | Workers 30s 限制是 CPU 时间，等待 I/O 不消耗；同步更简单且不会 30s 被掐断（早期 waitUntil+KV+轮询方案已退役） |
| 隧道自动同步 | trycloudflare 免费隧道 URL 每次重启都会变；守护脚本自动更新 secret + 重新部署 |
| 关键词触发线索 | LLM 输出 JSON 字段（reveals_clue）不可靠，关键词匹配 100% 可靠 |

---

## 三、目录结构

```
ai-detective/
├── public/
│   └── index.html          # ★ 前端单文件（约 1068 行）：HTML + CSS + JS 全在内
├── functions/
│   └── api/                # ★ Cloudflare Pages Functions（生产后端）
│       ├── _shared.js      #   共享：案件加载 / publicCase 脱敏 / prompt 组装 / CORS
│       ├── cases.js        #   GET /api/cases — 案件列表（含嫌疑人数量）
│       ├── case.js         #   GET /api/case?id=&mode= — 单个案件脱敏数据
│       ├── chat.js         #   POST /api/chat — 同步审问（直接调本地模型返回）
│       └── accuse.js       #   POST /api/accuse — 指控裁决（服务端判定）
├── cases/                  # ★ 案件数据（4 案 16 嫌疑人，唯一事实来源）
│   ├── manor.json          #   布莱克伍德庄园谋杀案（1930s 英国）
│   ├── station.json        #   曙光号谋杀案（太空站）
│   ├── magic.json          #   大魔术师之死（剧场）
│   └── nightclub.json      #   百乐门歌女之死（民国上海）
├── server.py               # ★ 本地开发后端（python http.server，端口 8899）
├── electron/
│   └── main.js             # Electron 主进程（打包版桌面端）
├── capacitor.config.ts     # Capacitor 配置（Android 打包）
├── wrangler.toml           # Cloudflare Pages 部署配置（vars）
├── netlify/                # 【历史遗留】Netlify Functions（已弃用，勿改）
├── netlify.toml            # 【历史遗留】Netlify 配置（已弃用）
├── tunnel/
│   ├── check_tunnel.sh     # ★ 隧道守护脚本（launchd 每 120s 执行）
│   ├── cloudflared.log     #   隧道日志（被 .gitignore 忽略）
│   └── current_url         #   当前隧道 URL（被 .gitignore 忽略）
├── .github/workflows/
│   └── build.yml           # 三平台安装包构建（仅 tag/手动触发）
├── package.json            # Electron/Capacitor 依赖与打包配置
├── release/                # 安装包产物（git 忽略）
└── .env                    # 本地密钥（git 忽略，绝不提交）
```

---

## 四、前端（public/index.html）

单文件应用（HTML + CSS + JS），无构建步骤，纯原生。约 56 个函数。

### 4.1 界面流（screen 状态机）

```
screen-auth ──注册/登录──▶ screen-intro（案件列表/案件详情/玩法说明）
                              │ 选案件
                              ▼
                       screen-suspects（嫌疑人列表）
                              │ 点嫌疑人
                              ▼
                       screen-interrogation（审问聊天）
                              │ 点证据 / 指控
                    ┌─────────┴─────────┐
                    ▼                   ▼
            screen-notebook        screen-accuse
            （证据笔记本）            （选凶手+证据）
                                        │ 提交
                                        ▼
                                 screen-verdict（结局）
```

- `go(id)`：切换 `.screen.active`，带 fade 过渡（0.28s）
- 每次切屏自动 `saveProgress()`（localStorage）

### 4.2 核心函数

| 函数 | 职责 |
|------|------|
| `fetchJSON(url, opts)` | **API 统一入口**：打包版（file:// 或 Capacitor）自动指向 `https://ai-detective-game.pages.dev`；网页版用相对路径 `/api/*`；120s 超时（同步审问等待）；网络错误返回 `{__network_error}` 标记 |
| `sendMsg()` | 发送提问：扣 1 行动点 → POST `/api/chat`（同步等待回复）→ 渲染回答 → 处理新线索 |
| `startInterrogation(id)` | 进入审问：按嫌疑人独立历史（`histories[suspectId]`），切换/返回不丢失 |
| `renderRelations()` | 案件详情页"涉案人员"区块：名字 + 关系 + 背景故事（可引导可误导，不点破动机） |
| `spendAP(n)` / `refundAP(n)` | 行动点增减，上限 10，失败自动退还 |
| `renderNotebook()` | 证据笔记本：显示线索标题/描述/来源/关键标记 |
| `submitAccuse()` | 指控：POST `/api/accuse` → 显示裁决 → 定罪/证据不足/冤枉 |
| `doRegister` / `doLogin` | 用户注册登录（localStorage + SHA-256 加盐） |

### 4.3 打包版判定（fetchJSON 核心逻辑）

```js
const isPacked = location.protocol === 'file:'      // Electron
  || (location.hostname === 'localhost' && location.port === '');  // Capacitor
if (isPacked) apiUrl = 'https://ai-detective-game.pages.dev' + url;
```

- **网页版**：相对路径 `/api/*`，同源无 CORS
- **Electron**：`file://` 加载 + `webSecurity: false`（electron/main.js）绕过 CORS
- **Capacitor**：`https://localhost` 加载，前端检测 `CapacitorHttp` 插件走原生 HTTP（WebView CORS 绕过）

### 4.4 关键状态变量

```js
CASE            // 当前案件脱敏数据（/api/case 返回）
currentSuspect  // 当前审问的嫌疑人
history         // 当前嫌疑人对话（引用 histories[suspectId]）
histories       // { suspectId: [...] } 按嫌疑人独立保存
ownedClues      // 已收集线索 id 数组
clueDetails     // 已收集线索详情（title/desc/source/is_key）
accuseSuspect   // 指控对象 id
actionPoints    // 行动点（10 起，提问-1，指控-2）
difficulty      // 'normal' | 'hard'
```

---

## 五、后端（Cloudflare Pages Functions）

### 5.1 路由映射

| 文件 | 路由 | 方法 | 职责 |
|------|------|------|------|
| `cases.js` | `/api/cases` | GET | 案件列表（id/title/era/intro/suspect_count） |
| `case.js` | `/api/case?id=&mode=` | GET | 单个案件**脱敏数据**（无 truth/secrets/lies） |
| `chat.js` | `/api/chat` | POST | 审问：**同步执行**，组装 prompt → 隧道 → 本地 LM Studio → 直接返回 |
| `accuse.js` | `/api/accuse` | POST | 指控裁决（服务端，mode=hard 用反转真相） |

> ⚠️ 曾经存在 `chat-result.js`（异步轮询），已随同步化删除。

### 5.2 chat 同步机制（关键架构）

```js
export const onRequest = async ({ request, env }) => {
  // 同步执行：组装 prompt → fetch 隧道 → 本地 LM Studio → 直接返回结果
  const llmResp = await fetch(envCfg.baseUrl + '/chat/completions', { ... });
  return corsJson({ reply, mood, new_clues, backend });
};
```

1. 前端 POST `/api/chat` → 后端同步调本地模型（15-50s）→ **直接返回** `{reply, mood, new_clues}`
2. 前端 fetch 超时 120s（`AbortSignal.timeout(120000)` 覆盖模型最慢响应）

> ⚠️ **为什么同步可行**：Cloudflare Workers 的 30s 限制是 **CPU 时间**；fetch 等待网络 I/O **不消耗 CPU 配额**，因此同步等待 15-50s 完全合法。
> 早期用 `waitUntil()` 异步方案（202 + KV + 轮询）有两个问题：waitUntil 只能延长执行最多 30s（一半请求会被掐断），且引入 KV/task_id 一整条复杂度。**已整体退役**：`chat-result.js`、KV 绑定、前端轮询已删除。

> ⚠️ **历史教训（Netlify 时代）**：传给后台任务的 Promise 内部所有异步必须 `await` 且 try/catch，未处理的 rejection 会导致任务静默失败。

### 5.3 CORS 处理（_shared.js）

```js
corsJson(obj, status)     // JSON 响应 + Access-Control-Allow-Origin: *
corsPreflight()           // OPTIONS → 204 + CORS 头
```

5 个函数全部接入（chat.js 在 body 解析前处理 OPTIONS）。

### 5.4 关键词线索触发（chat.js）

```js
function checkKeywordTriggers(caseData, question) {
  // 遍历线索的 trigger_keywords，问题命中关键词 → 返回线索
  // 去重：跳过玩家已拥有（owned_clues）
  // 困难模式：is_key 用 hard_mode.key_clues 重新判定
}
```

100% 可靠（不依赖 LLM 自觉），一次最多触发 2 条。

---

## 六、案件数据模型（cases/*.json）

**唯一事实来源**。改案情 = 改 JSON，无需动代码。

```jsonc
{
  "id": "manor",
  "title": "布莱克伍德庄园谋杀案",
  "era": "1930年代英国乡村",
  "intro": "雨夜，布莱克伍德庄园的主人亨利被发现死在书房……",
  "scene": "壁炉火已熄灭，地毯上有大片血迹……",
  "time_limit_hint": "昨晚 21:30 - 22:30 之间",
  "truth": {                        // ★ 真相（绝不下发前端）
    "killer": "brother",            //   凶手 = 嫌疑人 id
    "murder_weapon": "书房铜烛台",
    "murder_time": "22:00 左右",
    "summary": "马库斯沉迷赌博欠下巨额赌债……"
  },
  "suspects": [                     // 4 名嫌疑人
    {
      "id": "butler",
      "name": "阿尔弗雷德",
      "role": "管家",               // 与死者关系
      "emoji": "🕴️",
      "age": 58,
      "appearance": "花白头发……",
      "personality": "严谨、忠诚但懦弱……",
      "speech": "说话恭敬、啰嗦……",
      "secret": "他偷了亨利的一只金怀表……",   // ★ 角色秘密（进 prompt，不下发）
      "lies": [                      // ★ 谎言列表（进 prompt，不下发）
        { "topic": "昨晚去向", "lie": "一直在酒窖", "truth": "22:00 在书房门口" }
      ],
      "clues_available": ["clue_01", "clue_02"],  // 该嫌疑人能揭示的线索
      "motive": "怨恨、偷窃",        // 动机（进 prompt 让 LLM 表演合理）
      "opening_line": "侦探先生……我在这座庄园伺候了二十年……",
      "suggested_questions": ["案发时你在哪里？", "你昨晚见过死者吗？"],
      "background": "在庄园伺候了二十年，老主人吝啬刻薄……"  // ★ 开局展示（可引导可误导）
    }
  ],
  "clues": [                        // 线索（含关键词触发规则）
    {
      "id": "clue_01",
      "title": "证人证词：马库斯进入书房",
      "desc": "露西承认：22:00 左右看到马库斯进入书房……",
      "source": "露西",
      "is_key": true,               // 关键线索（定罪必需）
      "trigger_keywords": ["谁进", "进书房", "书房门口", "端茶", "走廊", "几点", "几点钟", "什么时候"]
    }
  ],
  "hard_mode": {                    // ★ 困难模式（真相反转）
    "truth": { "killer": "butler", "murder_weapon": "书房铜烛台", "murder_time": "21:55 左右", "summary": "管家阿尔弗雷德……" },
    "key_clues": ["clue_02", "clue_03"],          // 关键线索重新分配
    "clue_overrides": { "clue_01": { "title": "...", "desc": "..." } },  // 线索文案反转
    "suspect_lie_overrides": { "butler": ["..."] }, // 谎言覆盖
    "suspect_extra": { "butler": "你是真凶……" }   // 嫌疑人附加设定
  }
}
```

### 字段下发规则（安全）

| 字段 | 下发前端？ | 说明 |
|------|-----------|------|
| `truth` | ❌ 永不 | 服务端裁决用 |
| `secret` / `lies` | ❌ 永不 | 仅注入 LLM prompt |
| `motive` | ❌ 不直接下发 | 注入 prompt 让表演合理 |
| `background` | ✅ | 开局展示的故事情节（可引导可误导） |
| `clues`（脱敏） | ✅ | desc/source/is_key，无 trigger_keywords |
| `opening_line` / `suggested_questions` | ✅ | 审问 UI 用 |
| `hard_mode` | ❌ 永不下发 | 其内容已通过 publicCase 的 overrides 处理 |

---

## 七、LLM 推理链路

### 7.1 prompt 组装（_shared.js `buildSystemPrompt`）

> ⚠️ 必须与 server.py `build_system_prompt` 保持行为一致（双后端对拍，防漂移）。
> 字段来源：`secret`（JSON 单数字符串）、`lies`（对象数组 `{topic, lie, truth}`，格式化后注入）、`speech`/`motive`/`clues_available` 均注入；**线索只注入当前嫌疑人 `clues_available` 的**（防全量泄漏）。

```
你是「案件名」中的角色 {name}（{role}），{age}岁。
外貌：...
性格：...
说话风格：...
案件背景 / 案发现场 / 时间提示
你的角色秘密（绝对不能承认）：{secret}
你必须遵守的谎言：{lies}
你的作案动机：{motive}
【困难模式特殊设定】{hard_mode.suspect_extra}
角色行为准则：
  1. 第一人称口语化，每轮只回答 1-2 句（30 字以内）
  2. 永不主动说"我是凶手"
  3. 被戳破谎言时紧张/回避/反问
  4. 玩家展示证据时慌乱/愤怒/沉默
线索揭示规则：只有玩家直接击中关键点才揭示线索，每次最多 1 条
可揭示线索：{clues_available 过滤后的线索}
输出格式（严格 JSON）：{"reply": "...", "mood": "calm|nervous|angry|evasive|sad", "reveals_clue": ["id"]}
```

### 7.2 LLM 请求参数

```jsonc
{
  "model": "qwen/qwen3.6-35b-a3b",
  "messages": [system + 最近 8 轮历史 + 当前问题],
  "temperature": 0.8,
  "max_tokens": 4000,          // ⚠️ 必须 ≥4000，否则 Qwen 思考型模型空回复
  "stream": false,
  "think": false,              // 关思考链
  "chat_template_kwargs": { "enable_thinking": false }
}
```

### 7.3 链路时序

```
玩家提问 → POST /api/chat（同步）
        → buildSystemPrompt → fetch {LM_BASE_URL}/chat/completions
        → cloudflared 隧道 → Mac 本地 LM Studio :1234
        → 模型推理 15-50s（35B MoE）
        → 直接返回 {reply, mood, new_clues}
        → 前端渲染回答 + 新线索弹窗
```

> **排障要点**：LM Studio 必须**运行 + 模型已加载**；Mac 必须开机；隧道必须在线。

---

## 八、本地开发后端（server.py）

Python 标准库实现（http.server），**无需任何依赖**，用于本地/局域网开发调试。

```bash
python3 server.py
# → http://localhost:8899
```

| 特性 | 说明 |
|------|------|
| 同步 chat | 直接调用本地模型（无异步，本地开发够用） |
| 解析重试 | LLM JSON 解析失败自动重试 3 次 |
| 关键词触发 | 与 Cloudflare 版同一套逻辑（问题 + 回答拼接匹配） |
| 指控裁决 | 与 Cloudflare 版同一套逻辑 |
| `BACKEND = "local"` | 硬编码，DeepSeek 已彻底禁用 |

> ⚠️ 启动必须用绝对路径（`ROOT = Path(__file__).resolve().parent`），`load_env()` 必须在 `BACKENDS` 求值之前。

---

## 九、隧道与守护（cloudflared + launchd）

### 9.1 为什么需要隧道

- LM Studio 只监听 `localhost:1234`，公网无法直接访问
- Cloudflare Pages Functions 需要访问你的本地模型 → 必须打通公网入口
- 方案：**Cloudflare Quick Tunnel**（免费 `*.trycloudflare.com`），**带 API key 认证**（无 key → 401）

### 9.2 三层守护（launchd）

| LaunchAgent | 作用 |
|-------------|------|
| `com.aidetective.tunnel` | cloudflared 常驻，崩溃自动重启，开机自启 |
| `com.aidetective.check` | 每 120s 执行 `check_tunnel.sh` |
| `com.aidetective.caffeinate` | 防休眠（合盖不断网） |

### 9.3 check_tunnel.sh 工作流

```
1. cloudflared 未运行 → 启动
2. 提取当前隧道 URL（从日志 grep trycloudflare.com）
3. 探测可用性（curl /v1/models，401 或 200 = 健康）
4. URL 变了（隧道重启）→ 同步 Cloudflare：
   a. wrangler pages secret put LM_BASE_URL（新 URL）
   b. wrangler pages deploy（重新部署让 secret 生效）
   c. ★ 部署后 chat 链路自验证（最多 3 次重试，根治 secret 传播竞态）
5. 探测失败 → 重启 cloudflared
```

> ⚠️ **重要教训**：launchd 环境不注入 HOME（`launchctl getenv HOME` 为空），
> 脚本必须 `export HOME="${HOME:-/Users/rc}"`，否则 wrangler 找 `/.wrangler/cache` 失败导致同步中断。
> plist 中同时注入 `EnvironmentVariables`（HOME + PATH）双保险。

### 9.4 手动运维

```bash
# 查看隧道状态
launchctl list | grep aidetective
cat tunnel/current_url          # 当前隧道 URL
tail -20 tunnel/cloudflared.log # 日志

# 重启守护（改 plist 后）
launchctl unload ~/Library/LaunchAgents/com.aidetective.check.plist
launchctl load ~/Library/LaunchAgents/com.aidetective.check.plist

# 手动同步隧道（模拟 URL 变化触发全流程）
rm -f tunnel/current_url && bash tunnel/check_tunnel.sh
```

---

## 十、部署（Cloudflare Pages + wrangler）

### 10.1 配置文件

```toml
# wrangler.toml
name = "ai-detective-game"
pages_build_output_dir = "public"

[vars]
LM_MODEL = "qwen/qwen3.6-35b-a3b"   # 注意：LM_BASE_URL 用 secret 管理（动态变化）
```

> ⚠️ 早期曾用 `[[kv_namespaces]]`（AID_CHAT_RESULTS）支撑异步 chat，已随同步化删除。

### 10.2 部署命令

```bash
# 登录
wrangler login

# 创建项目（首次）
wrangler pages project create ai-detective-game --production-branch main
wrangler pages project create ai-detective-staging --production-branch main

# 设置 secret（敏感值，用 stdin 传入避免进 shell 历史；staging + production 都要）
echo "https://xxx.trycloudflare.com/v1" | wrangler pages secret put LM_BASE_URL --project-name ai-detective-game
echo "<key>" | wrangler pages secret put LM_API_KEY --project-name ai-detective-game

# 部署
wrangler pages deploy public --project-name ai-detective-game --commit-dirty=true
```

### 10.3 环境变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `LM_BASE_URL` | secret | 隧道地址（动态！守护脚本自动更新） |
| `LM_API_KEY` | secret | LM Studio API key |
| `LM_MODEL` | vars | 模型名 |

> ⚠️ 为什么 `LM_BASE_URL` 必须用 secret 而不用 `[vars]`？
> wrangler 禁止同名 vars + secret 绑定冲突；且 secret 可被守护脚本动态更新。

### 10.4 部署注意

- `functions/api/*.js` 目录 = 路由 `/api/*`（Pages Functions 约定）
- 案件 JSON 通过 `import` 内嵌进 bundle（Workers 无文件系统）
- `wrangler pages deploy public` 会自动打包 functions 目录

---

## 十一、测试服（staging）与发布流程

### 11.1 双环境

| 环境 | 项目名 | 地址 | 用途 |
|------|--------|------|------|
| **生产** | `ai-detective-game` | `https://ai-detective-game.pages.dev` | 玩家使用，永不直接改 |
| **测试** | `ai-detective-staging` | `https://ai-detective-staging.pages.dev` | 开发优化先行验证 |

**为什么选独立 Pages 项目而不是本地 `wrangler dev`**：
- staging 与生产**完全同构**（同代码/同隧道/同 CORS/同限流），能复现一切真实公网链路问题（530、隧道变化、CORS）
- 本地 `wrangler dev` 直连 localhost LM Studio，**不走隧道**，测不出公网问题
- staging 公网可访问，手机也能实测；部署/回滚与生产互不影响

### 11.2 测试服部署

```bash
# 部署测试服（改动代码后先跑这里）
wrangler pages deploy public --project-name ai-detective-staging --commit-dirty=true

# 设置 secrets（仅首次/隧道变化时）
echo "https://xxx.trycloudflare.com/v1" | wrangler pages secret put LM_BASE_URL --project-name ai-detective-staging
echo "<key>" | wrangler pages secret put LM_API_KEY --project-name ai-detective-staging

# 验证 staging chat 链路
curl -s --max-time 120 -X POST "https://ai-detective-staging.pages.dev/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"case_id":"manor","suspect_id":"butler","question":"你好","history":[],"owned_clues":[],"mode":"normal"}'
```

### 11.3 标准发布流程（staging 先行）

```
1. 修改代码（prompt/案件/功能）
2. 部署测试服：wrangler pages deploy public --project-name ai-detective-staging
3. 在 staging 上验证：全流程试玩 / API 测试 / chat 链路
4. 验证无问题 → 部署生产：wrangler pages deploy public --project-name ai-detective-game
5. （隧道 URL 变化时，守护脚本自动同步两个项目，见 9.3）
```

> ⚠️ **红线**：不要在未经过 staging 验证的情况下直接部署生产——玩家的游玩体验依赖生产稳定性。

### 11.4 隧道守护双项目同步

`check_tunnel.sh` 在隧道 URL 变化时**同时同步 staging + production**（两个项目都更新 secret + 部署 + chat 自验证）。任一个同步失败都会**删除 current_url**，下次运行自动重试（不会永久跳过）。



### 11.5 三平台

| 平台 | 技术 | 产物 |
|------|------|------|
| Windows | electron-builder + NSIS | `.exe`（77MB） |
| macOS | electron-builder + DMG | `.dmg`（arm64 94MB / x64 98MB） |
| Android | Capacitor 7 + Gradle | `.apk`（debug，3.9MB） |

### 11.6 触发方式

```yaml
on:
  push:
    tags: ['v*']        # 打 tag 触发
  workflow_dispatch:    # 或手动触发
```

> 已**暂停自动构建**（push main 不再触发），避免每次提交都消耗 Actions 分钟数。

### 11.7 手动构建

```bash
# 打 tag 触发（或 GitHub 页面手动 Run workflow）
git tag v1.1.0 && git push origin v1.1.0

# 下载产物
gh run download <run_id> --repo RexCheung6/ai-detective --dir release/artifacts
```

### 11.8 打包版联网链路

```
安装包 UI（file:// 或 https://localhost）
  → fetchJSON 判定 isPacked → 指向 https://ai-detective-game.pages.dev
  → Cloudflare Functions → 隧道 → 你的 Mac LM Studio
```

> ⚠️ 打包版**必须联网**才能玩（模型在你的 Mac 上）；测试者游玩时你的 Mac 须开机 + LM Studio 运行。

---

## 十二、用户系统与进度保存

全部**纯前端 localStorage**（⚠️ **纯本地存档**，无真实鉴权——SHA-256 加盐哈希可被直接篡改/清空，仅用于区分玩家与保存进度，不适合作为安全凭证）。

| 存储键 | 内容 |
|--------|------|
| `aid_users` | `{username: {salt, hash}}`（SHA-256 加盐） |
| `aid_session` | 当前登录用户名 |
| `aid_progress_<username>` | 完整游戏进度 |

进度数据：

```jsonc
{
  "caseId": "manor",
  "mode": "normal",
  "screen": "screen-interrogation",
  "suspectId": "butler",
  "history": [...],          // 当前嫌疑人对话
  "histories": {...},        // 所有嫌疑人独立历史
  "ownedClues": [...],
  "clueDetails": [...],
  "accuseSuspect": null,
  "actionPoints": 7,
  "updatedAt": 1755252000000
}
```

- 每次切屏/提问/指控自动保存
- 重新登录自动 `restoreProgress()` 回到上次界面（含完整聊天记录）
- 按嫌疑人独立历史：切换/返回/退出重登都不丢记录

---

## 十三、常见问题与排障

### 13.1 "后端出错：LLM HTTP 530"

```
隧道掉线/URL 变化，但 Cloudflare secret 还是旧地址
```

排查顺序：
1. `cat tunnel/current_url` + `tail tunnel/cloudflared.log` — 隧道是否在线、URL 是否变了
2. `curl -H "Authorization: Bearer <key>" <url>/v1/models` — 隧道直连是否 200/401
3. 若 URL 变了：手动 `rm -f tunnel/current_url && bash tunnel/check_tunnel.sh` 触发同步
4. 同步后等 1 分钟（守护会 chat 自验证），再测

### 13.2 chat 超时 / 报错

- **先查 staging**：访问 `https://ai-detective-staging.pages.dev` 复现——测试服与生产同构，能快速区分"代码问题"还是"生产环境问题"
- LM Studio 未运行 / 模型未加载
- Mac 休眠（检查 caffeinate）
- 模型推理慢（35B MoE 正常 15-50s；前端 fetch 超时 120s，超时会退款）
- 隧道问题（见 13.1）

### 13.3 打包版无法登录/注册

- 根因是 CORS：`file://` / `https://localhost` 跨域请求被拦
- Electron：`webSecurity: false`（electron/main.js）
- Android：CapacitorHttp 原生 HTTP 插件
- 服务端：`Access-Control-Allow-Origin: *`（_shared.js corsJson）

### 13.4 Qwen 空回复

- `max_tokens` 必须 ≥4000
- 不要传 `enable_thinking: false` 单独使用（配合 `think: false` + `chat_template_kwargs` 组合）

### 13.5 修改案件后不生效

- Cloudflare 版：案件 JSON 被 `import` 内嵌进 bundle → **必须重新部署** `wrangler pages deploy`
- 本地版：重启 `server.py`

---

## 十四、开发约定与安全红线

### ✅ 必须遵守

1. **LLM 只表演不创作事实**：新案件/新嫌疑人的所有秘密、谎言、真相必须写进 JSON，prompt 里只注入设定
2. **密钥绝不进前端**：`LM_API_KEY` 只在 server.py / Cloudflare secret / 隧道守护脚本
3. **`.env` 绝不 git 跟踪**（已在 .gitignore，推 GitHub 前复查 `git status`）
4. **前端零公网地址硬编码**（除打包版指向 pages.dev 的绝对地址）
5. **案件数据脱敏**：`publicCase` 只返回白名单字段，`truth`/`secret`/`lies`/`hard_mode` 永不下发
6. **改隧道/部署逻辑后**：实测一次 `check_tunnel.sh` 全流程（删 current_url 触发）

### ❌ 禁止

- 把 `DEEPSEEK_API_KEY` / `LM_API_KEY` 真实值写进任何文件再提交
- 移除 `publicCase` 脱敏字段
- 在 Cloudflare 版引入 Node fs（Workers 无文件系统）
- 把 `max_tokens` 降到 4000 以下
- 改动 `netlify/` 目录（已弃用，仅作历史参考）

### 🧪 开发验证建议

```bash
# 1. 语法检查
node --check functions/api/*.js
bash -n tunnel/check_tunnel.sh

# 2. 本地起服务测试
python3 server.py   # http://localhost:8899

# 3. 测试服验证（Chat 全链路）
# 先部署 staging，再 curl 验证：POST /api/chat → 应 15-50s 直接返回 reply
curl -s --max-time 120 -X POST "https://ai-detective-staging.pages.dev/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"case_id":"manor","suspect_id":"butler","question":"你好","history":[],"owned_clues":[],"mode":"normal"}'

# 4. 验证通过后部署生产
wrangler pages deploy public --project-name ai-detective-game --commit-dirty=true
```

---

## 附：技术栈速查

| 层 | 技术 | 版本/要点 |
|----|------|-----------|
| 前端 | 原生 HTML/CSS/JS | 单文件，无构建 |
| 云后端 | Cloudflare Pages Functions | wrangler 4.x；生产 + 测试双项目 |
| 本地模型 | LM Studio | `localhost:1234`，`qwen/qwen3.6-35b-a3b`（MoE） |
| 隧道 | cloudflared | Quick Tunnel，带 key 认证 |
| 桌面打包 | Electron | v33.x，`webSecurity: false` |
| 移动打包 | Capacitor | v7，`androidScheme: https` |
| CI | GitHub Actions | 仅 tag/手动触发 |
| 本地开发 | Python http.server | 端口 8899，零依赖 |

---

## 附：版本历史

> **约定**：每个版本追加一个新章节（按时间倒序，最新在最上），只描述相对上一版本的变化。
> V1.0 为 cornerstone，其内容固化在本文档正文各章节中，后续版本不修改正文，仅在此追加。

---

### v1.1+（未来版本占位）

<!-- 新版本在此处追加：
### vX.Y（日期）
- 变更 1
- 变更 2
-->

---

### v1.0（Cornerstone，2026-08-16）

**定位**：功能完整、双环境（测试/生产）就绪、架构稳定固化的首个基准版本。本文档全部正文章节即为此版本快照。

**核心特性**：
- 4 个案件（庄园/太空站/魔术师/百乐门），16 名嫌疑人，普通 + 困难（真相反转）双模式
- LLM 实时角色扮演审问（本地 LM Studio `qwen/qwen3.6-35b-a3b`），真相/秘密/谎言服务端 JSON 预置，LLM 只表演不创作
- 行动点系统（10 点，提问 -1/指控 -2，失败自动退还）+ 关键词线索触发（100% 可靠）+ 服务端指控裁决
- 涉案人员背景故事展示（开局可见，可引导可误导，动机留给玩家猜）
- 按嫌疑人独立对话历史，切换/返回/重登不丢失

**架构要点（详见正文）**：
- 前端单文件 `public/index.html`（原生 HTML/CSS/JS，零构建）
- 后端 Cloudflare Pages Functions（`/api/*`），**chat 同步执行**（Workers 30s 限制是 CPU 时间，等待 I/O 不消耗）
- 生产 `ai-detective-game.pages.dev` + 测试 `ai-detective-staging.pages.dev` 双环境，**staging 先行**发布流程
- cloudflared 隧道 + launchd 三层守护（隧道/健康检查/防休眠），URL 变化自动同步双项目（secret + 部署 + chat 自验证）
- 用户系统纯前端 localStorage（SHA-256 加盐，纯本地存档）
- 三平台安装包（Electron Windows/macOS + Capacitor Android），GitHub Actions 仅 tag/手动触发

**关键配置**：
- 环境变量：`LM_BASE_URL`（secret，动态）/ `LM_API_KEY`（secret，2026-08-16 已轮换）/ `LM_MODEL`
- git 历史已重写：清除曾泄露的 LM API key；`.env` / `.wrangler` / `netlify/` 均不入库

**V1.0 已知边界**：
- 打包版（Electron/Capacitor）需联网 + 本机 LM Studio 运行才能游玩
- 免费 trycloudflare 隧道 URL 重启会变（守护自动处理，可能有 1-2 分钟切换窗口）
- 公共 API 暂无按 IP 限流（可用 KV 计数器补，见"可选改进"）
