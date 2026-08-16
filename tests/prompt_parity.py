#!/usr/bin/env python3
"""
双后端对拍脚本（V1.1）
=====================
校验 server.py（Python 本地后端）与 functions/api/_shared.js（Cloudflare 生产后端）
在 prompt 渲染和 public_case 脱敏上的行为一致性，防止双后端漂移。

用法：
    python3 tests/prompt_parity.py            # 全部检查
    python3 tests/prompt_parity.py --quick    # 只检查 public_case 字段 + prompt 关键段

依赖：
    - Node.js（用于渲染 _shared.js 的 buildSystemPrompt / publicCase）
    - 无第三方 Python 包
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CASES_DIR = ROOT / "cases"
SERVER_PY = ROOT / "server.py"
SHARED_JS = ROOT / "functions/api/_shared.js"

CASES = ["manor", "station", "magic", "nightclub"]
MODES = ["normal", "hard"]


def load_case(case_id: str) -> dict:
    return json.loads((CASES_DIR / f"{case_id}.json").read_text())


# ---------- Python 侧（直接 import server.py） ----------

def py_render(case: dict, suspect: dict, mode: str) -> str:
    """调用 server.py 的 build_system_prompt"""
    sys.path.insert(0, str(ROOT))
    import server  # noqa: E402
    return server.build_system_prompt(case, suspect, mode)


def py_public_case(case: dict, mode: str) -> dict:
    sys.path.insert(0, str(ROOT))
    import server  # noqa: E402
    return server.public_case(case, mode)


# ---------- Node 侧（构造注入版 .mjs，避开 ESM JSON import attribute 坑） ----------

def node_render(case: dict, suspect: dict, mode: str) -> str:
    """调用 _shared.js 的 buildSystemPrompt（注入案件数据）"""
    return _node_call("buildSystemPrompt", case, suspect, mode)


def node_public_case(case: dict, mode: str) -> dict:
    return json.loads(_node_call("publicCase", case, None, mode))


def _node_call(fn_name: str, case: dict, suspect, mode: str) -> str:
    src = SHARED_JS.read_text()
    # 去掉 JSON import（改由注入提供）
    for cid in CASES:
        src = src.replace(f"import {cid} from '../../cases/{cid}.json';", "")
    head = "import { readFileSync } from 'fs';\n" + "".join(
        f"const {cid} = JSON.parse(readFileSync('{CASES_DIR / (cid + '.json')}', 'utf8'));\n"
        for cid in CASES
    )
    case_var = case["id"]
    if fn_name == "buildSystemPrompt":
        suspect_json = json.dumps(suspect, ensure_ascii=False)
        call = (
            f"const result = buildSystemPrompt({case_var}, "
            f"JSON.parse({json.dumps(suspect_json)}), {json.dumps(mode)});\n"
            "console.log(result);"
        )
    else:
        call = f"console.log(JSON.stringify(publicCase({case_var}, {json.dumps(mode)})));"
    test_src = head + src + "\n" + call
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as f:
        f.write(test_src)
        tmp_path = f.name
    try:
        r = subprocess.run(["node", tmp_path], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError(f"node 执行失败: {r.stderr[:500]}")
        return r.stdout.strip()
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ---------- 归一化（容忍 LLM prompt 中必然的差异点） ----------

def normalize_prompt(p: str) -> str:
    """归一化：压缩空白，避免空格/换行差异造成误报"""
    return re.sub(r"\s+", " ", p).strip()


# ---------- 主流程 ----------

def check_prompt_parity(quick: bool) -> tuple[int, list[str]]:
    fails = []
    total = 0
    for cid in CASES:
        case = load_case(cid)
        for mode in MODES:
            for s in case["suspects"]:
                total += 1
                py_p = normalize_prompt(py_render(case, s, mode))
                node_p = normalize_prompt(node_render(case, s, mode))
                if py_p != node_p:
                    # 找第一个差异位置帮助定位
                    diff_at = next(
                        (i for i in range(min(len(py_p), len(node_p))) if py_p[i] != node_p[i]),
                        min(len(py_p), len(node_p)),
                    )
                    fails.append(
                        f"[prompt] {cid}/{s['id']}/{mode} 不一致 @{diff_at}:\n"
                        f"  py  : ...{py_p[max(0, diff_at-30):diff_at+40]}...\n"
                        f"  node: ...{node_p[max(0, diff_at-30):diff_at+40]}..."
                    )
    return total, fails


def check_public_case_parity(quick: bool) -> tuple[int, list[str]]:
    fails = []
    total = 0
    for cid in CASES:
        case = load_case(cid)
        for mode in MODES:
            total += 1
            py_c = py_public_case(case, mode)
            node_c = node_public_case(case, mode)
            if py_c != node_c:
                # 定位字段差异
                keys = set(py_c) | set(node_c)
                diffs = []
                for k in sorted(keys):
                    if py_c.get(k) != node_c.get(k):
                        diffs.append(k)
                fails.append(f"[public_case] {cid}/{mode} 字段差异: {diffs}")
    return total, fails


def main():
    parser = argparse.ArgumentParser(description="双后端对拍")
    parser.add_argument("--quick", action="store_true", help="快速模式：只对拍 public_case 字段 + 抽查 prompt")
    args = parser.parse_args()

    print("=" * 60)
    print("双后端对拍：server.py (py) vs functions/api/_shared.js (node)")
    print("=" * 60)

    all_fails = []
    total = 0

    if args.quick:
        # 快速模式：public_case 全量 + prompt 抽查（每案每模式第一个嫌疑人）
        t, fails = check_public_case_parity(True)
        total += t
        all_fails += fails
        for cid in CASES:
            case = load_case(cid)
            for mode in MODES:
                s = case["suspects"][0]
                total += 1
                py_p = normalize_prompt(py_render(case, s, mode))
                node_p = normalize_prompt(node_render(case, s, mode))
                if py_p != node_p:
                    all_fails.append(f"[prompt抽查] {cid}/{s['id']}/{mode} 不一致")
    else:
        t, fails = check_prompt_parity(False)
        total += t
        all_fails += fails
        t2, fails2 = check_public_case_parity(False)
        total += t2
        all_fails += fails2

    print(f"\n共检查 {total} 项")
    if all_fails:
        print(f"❌ {len(all_fails)} 项不一致：")
        for f in all_fails[:10]:
            print(f"  {f}")
        if len(all_fails) > 10:
            print(f"  ... 等共 {len(all_fails)} 项")
        sys.exit(1)
    print("✅ 全部一致，双后端无漂移")
    sys.exit(0)


if __name__ == "__main__":
    main()
