#!/usr/bin/env python3
"""
AI 侦探游戏后端代理
- 托管前端静态文件 (public/)
- /api/case    -> 返回脱敏案件数据（不含真相/秘密/谎言）
- /api/chat    -> 组装审问 prompt，转发给 LLM（默认本地 LM Studio），解析 JSON 返回
- /api/accuse  -> 判定指控结果（服务端裁决，玩家无法作弊）

运行: python3 server.py            # 默认本地模型 (LM Studio localhost:1234)
      BACKEND=deepseek python3 server.py   # 切到 deepseek 云端
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 用 resolve() 保证基于绝对路径定位文件，不受进程 cwd 影响
ROOT = Path(__file__).resolve().parent
CASES_DIR = ROOT / "cases"
PUBLIC_DIR = ROOT / "public"


def load_env():
    """从 .env 读取配置，直接覆盖环境变量（.env 优先）"""
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip().strip('"')


load_env()  # 必须在 BACKENDS 求值之前调用，否则 BACKENDS 用的是旧环境变量

PORT = int(os.environ.get("PORT", 8899))
BACKEND = os.environ.get("BACKEND", "local").lower()

# ---------- LLM 后端配置 ----------
BACKENDS = {
    "local": {
        "base_url": os.environ.get("LM_BASE_URL", "http://localhost:1234/v1"),
        "model": os.environ.get("LM_MODEL", "qwen/qwen3.6-35b-a3b"),
        "api_key": os.environ.get("LM_API_KEY", "lm-studio"),
        "label": "本地 LM Studio",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-v4-flash",
        "api_key": os.environ.get("DEEPSEEK_API_KEY", ""),
        "label": "DeepSeek 云端",
    },
}

# ---------- 案件数据 ----------


def load_case(case_id: str) -> dict:
    path = CASES_DIR / f"{case_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"case {case_id} not found")
    return json.loads(path.read_text())


def public_case(case: dict) -> dict:
    """脱敏：只返回玩家该知道的信息"""
    return {
        "id": case["id"],
        "title": case["title"],
        "era": case["era"],
        "intro": case["intro"],
        "scene": case["scene"],
        "time_limit_hint": case.get("time_limit_hint", ""),
        "suspects": [
            {
                "id": s["id"],
                "name": s["name"],
                "role": s["role"],
                "emoji": s["emoji"],
                "age": s["age"],
                "appearance": s["appearance"],
                "personality": s["personality"],
                "opening_line": s["opening_line"],
                "clues_available": s["clues_available"],
                "suggested_questions": s.get("suggested_questions", []),
            }
            for s in case["suspects"]
        ],
        "clues": [
            {"id": c["id"], "title": c["title"], "desc": c["desc"],
             "source": c["source"], "is_key": c.get("is_key", False)}
            for c in case["clues"]
        ],
    }


# ---------- Prompt 组装 ----------


def build_system_prompt(case: dict, suspect: dict) -> str:
    lies_text = "\n".join(
        f"- 话题「{l['topic']}」：你必须撒谎说「{l['lie']}」。真相是「{l['truth']}」，但绝不能承认。"
        for l in suspect["lies"]
    )
    clues_text = "\n".join(
        f"- {c['title']}：{c['desc']}"
        for c in case["clues"] if c["id"] in suspect["clues_available"]
    )
    return f"""你正在扮演一名角色扮演游戏中的嫌疑人。你是「{suspect['name']}」，{suspect['role']}，{suspect['age']}岁。
外貌：{suspect['appearance']}
性格：{suspect['personality']}
说话风格：{suspect['speech']}

案件背景：
{case['intro']}
案发现场：{case['scene']}
{case.get('time_limit_hint', '')}

你的角色秘密（绝对不能承认，被追问时要转移话题或反问）：
{suspect['secret']}

你必须遵守的谎言（玩家问到相关话题时，必须按谎言回答，永远不能透露真相）：
{lies_text}

你的作案动机（你本人可能是清白的，但动机要合理）：
{suspect['motive']}

角色行为准则：
1. 用第一人称、口语化回答，符合你的性格和说话风格，每轮 1-3 句话，不要长篇大论。
2. 你是嫌疑人，不是侦探——永远不要主动说"我是凶手"或"某某是凶手"。
3. 被问到你撒谎的话题时，按谎言回答，被追问得紧就紧张、回避、反问。
4. 玩家展示证据或戳破你谎言时，你会慌乱/愤怒/沉默。

线索揭示规则（重要）：
- 你拥有以下可揭示的线索。当玩家的问题**触及相关话题**，或你为了自证清白/转移嫌疑，或你被逼到墙角时，就把对应线索 id 填入 reveals_clue。
- 每次回答最多揭示 1 条新线索，不要把全部线索一口气倒出来。
- 线索在回答正文中自然带出（比如提到"我当时看到/听到/知道……"），同时把 id 写进 reveals_clue。
- 玩家第一次问到相关话题但你没有把握时，可以先不给线索；第二次追问或换角度再问时必须给。

可揭示线索：
{clues_text}

输出格式（严格 JSON，不要输出其他任何内容）：
{{"reply": "你的回答", "mood": "calm|nervous|angry|evasive|sad", "reveals_clue": ["线索ID数组，没有则[]"]}}"""


# ---------- LLM 调用 ----------


def call_llm(system: str, history: list, user_msg: str) -> dict:
    cfg = BACKENDS[BACKEND]
    if not cfg["api_key"] and BACKEND == "deepseek":
        raise RuntimeError("DEEPSEEK_API_KEY 未配置，无法使用云端后端")

    messages = [{"role": "system", "content": system}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_msg})

    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": 0.8,
        "max_tokens": 2000,
        "stream": False,
        # Qwen 思考型模型：think=False / chat_template_kwargs 可关思维链加速。
        # 注意：不要传 enable_thinking=False —— 会让该模型输出空内容（token 全耗在思考上）
        "think": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        f"{cfg['base_url']}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['api_key']}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


def parse_llm_json(text: str) -> dict:
    """容错解析：剥离 markdown 代码块，截取第一个 JSON 对象"""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"no JSON object in LLM output: {text[:200]}")
    return json.loads(text[start:end + 1])


# ---------- HTTP 处理 ----------

CASES = {p.stem: load_case(p.stem) for p in CASES_DIR.glob("*.json")}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path):
        if not path.exists() or path.is_dir():
            self.send_error(404)
            return
        body = path.read_bytes()
        ctype = CONTENT_TYPES.get(path.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/cases":
            # 案件列表（仅元信息，不含任何秘密/真相）
            self._send_json([
                {"id": c["id"], "title": c["title"], "era": c["era"],
                 "intro": c["intro"][:80] + "…" if len(c["intro"]) > 80 else c["intro"],
                 "suspect_count": len(c["suspects"])}
                for c in CASES.values()
            ])
        elif self.path.startswith("/api/case?"):
            import urllib.parse
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1])
            case_id = qs.get("id", ["manor"])[0]
            if case_id not in CASES:
                self._send_json({"error": f"case {case_id} not found"}, 404)
            else:
                self._send_json(public_case(CASES[case_id]))
        elif self.path == "/api/case":
            self._send_json(public_case(CASES["manor"]))
        elif self.path.startswith("/api/"):
            self._send_json({"error": "not found"}, 404)
        else:
            # 静态文件
            rel = self.path.lstrip("/")
            if not rel:
                rel = "index.html"
            self._send_file(PUBLIC_DIR / rel)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json({"error": "bad json"}, 400)
            return

        if self.path == "/api/chat":
            self._handle_chat(body)
        elif self.path == "/api/accuse":
            self._handle_accuse(body)
        else:
            self._send_json({"error": "not found"}, 404)

    def _handle_chat(self, body):
        try:
            case = CASES[body["case_id"]]
            suspect = next(s for s in case["suspects"] if s["id"] == body["suspect_id"])
            history = body.get("history", [])
            question = body["question"]
            system = build_system_prompt(case, suspect)

            # 解析失败自动重试（最多 2 次），应对偶发的空回复/思考吞 token
            parsed = None
            last_err = None
            for attempt in range(3):
                try:
                    raw = call_llm(system, history, question)
                    parsed = parse_llm_json(raw)
                    if not parsed.get("reply", "").strip():
                        raise ValueError("empty reply")
                    break
                except Exception as e:
                    last_err = e
                    if attempt < 2:
                        print(f"[retry] LLM 输出解析失败 ({e}), 第 {attempt+2} 次尝试…")
            if parsed is None:
                raise last_err

            # 校验揭示的线索属于该嫌疑人
            valid_clues = set(suspect["clues_available"])
            revealed = [c for c in parsed.get("reveals_clue", []) if c in valid_clues]
            # 关键词规则触发（不依赖 LLM 的 JSON 字段，100% 可靠）：
            # 玩家问题或嫌疑人回答命中线索关键词 => 自动揭示
            # 限流：一次最多触发 2 条，避免一次对话解锁太多线索
            text_combined = question + " " + parsed.get("reply", "")
            for c in case["clues"]:
                if len(revealed) >= 2:
                    break
                if c["id"] in valid_clues and c["id"] not in revealed:
                    kws = c.get("trigger_keywords", [])
                    if any(kw in text_combined for kw in kws):
                        revealed.append(c["id"])
            # 去重：只返回玩家尚未拥有的
            owned = set(body.get("owned_clues", []))
            new_clues = [c for c in revealed if c not in owned]
            clue_details = [
                {k: v for k, v in c.items() if k != "trigger_keywords"}
                for c in case["clues"] if c["id"] in new_clues
            ]

            self._send_json({
                "reply": parsed.get("reply", "……"),
                "mood": parsed.get("mood", "calm"),
                "new_clues": clue_details,
                "backend": BACKENDS[BACKEND]["label"],
            })
        except Exception as e:
            self._send_json({"error": str(e)}, 500)

    def _handle_accuse(self, body):
        """指控判定：嫌疑人对 + 至少持有1条关键证据 => 定罪成功"""
        try:
            case = CASES[body["case_id"]]
            suspect_id = body["suspect_id"]
            evidence_ids = set(body.get("evidence_ids", []))
            truth = case["truth"]

            correct = suspect_id == truth["killer"]
            key_evidence_held = any(
                c["id"] in evidence_ids and c.get("is_key", False)
                for c in case["clues"]
            )

            if correct and key_evidence_held:
                result = "convicted"
            elif correct:
                result = "insufficient"
            else:
                result = "wrong"

            self._send_json({
                "result": result,
                "truth": truth if result in ("convicted", "wrong") else None,
            })
        except Exception as e:
            self._send_json({"error": str(e)}, 500)


def main():
    cfg = BACKENDS[BACKEND]
    key_hint = (cfg["api_key"][:8] + "..." + cfg["api_key"][-4:]) if len(cfg["api_key"]) > 12 else "(短key)"
    print(f"⚖️  AI 侦探游戏服务器")
    print(f"   🔌 后端: {BACKENDS[BACKEND]['label']} ({BACKENDS[BACKEND]['model']})")
    print(f"   🔑 API key: {key_hint} | base_url: {cfg['base_url']}")
    print(f"   📁 案件: {', '.join(CASES.keys())}")
    print(f"   🌐 打开: http://localhost:{PORT}")
    print(f"   （切到云端: BACKEND=deepseek python3 server.py）")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
