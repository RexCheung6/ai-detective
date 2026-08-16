#!/bin/bash
# ============================================================
# AI 侦探 · 隧道守护脚本
# 职责：
#   1. 检查 cloudflared 进程，不在则启动
#   2. 探测隧道可用性（带 API key，401 = 在线且有认证 = 正常）
#   3. 隧道 URL 变化时，自动更新 Cloudflare Pages secret 并重新部署
#   4. 部署后 chat 链路自验证，失败自动重试（根治 secret 传播竞态）
# 由 launchd 每 120 秒调用一次
# ============================================================

# launchd 环境不注入 HOME（launchctl getenv HOME 为空），必须兜底：
# 否则 wrangler 会找 /.wrangler/cache 而失败，导致隧道同步中断
export HOME="${HOME:-/Users/rc}"

export PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

CLOUDFLARED="$HOME/bin/cloudflared"
LOG_FILE="/Users/rc/project/new/ai-detective/tunnel/cloudflared.log"
URL_FILE="/Users/rc/project/new/ai-detective/tunnel/current_url"
# 从项目 .env 读取 LM_API_KEY（绝不硬编码；.env 已被 gitignore）
LM_API_KEY=""
if [ -f /Users/rc/project/new/ai-detective/.env ]; then
    LM_API_KEY=$(grep -E '^LM_API_KEY=' /Users/rc/project/new/ai-detective/.env | head -1 | cut -d= -f2- | tr -d '"'"'"'')
fi
mkdir -p /Users/rc/project/new/ai-detective/tunnel

# ---------- 1. 确保 cloudflared 进程在跑 ----------
if ! pgrep -f "cloudflared tunnel --url http://localhost:1234" > /dev/null; then
    echo "[$(date '+%F %T')] cloudflared 未运行，启动…" >> "$LOG_FILE"
    nohup "$CLOUDFLARED" tunnel --url http://localhost:1234 --no-autoupdate >> "$LOG_FILE" 2>&1 &
    # 等待隧道建立（最多 30 秒）
    for i in $(seq 1 30); do
        sleep 1
        grep -q "trycloudflare.com" "$LOG_FILE" 2>/dev/null && break
    done
fi

# ---------- 2. 提取当前隧道 URL ----------
CURRENT_URL=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" "$LOG_FILE" | tail -1)
if [ -z "$CURRENT_URL" ]; then
    echo "[$(date '+%F %T')] ⚠️ 尚未获取到隧道 URL" >> "$LOG_FILE"
    exit 1
fi

# ---------- 3. 探测隧道可用性（401 = 在线且有认证，视为健康） ----------
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
    -H "Authorization: Bearer $LM_API_KEY" \
    "$CURRENT_URL/v1/models" 2>/dev/null)

if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "200" ]; then
    # 隧道健康
    if [ -f "$URL_FILE" ] && [ "$(cat "$URL_FILE")" = "$CURRENT_URL" ]; then
        echo "[$(date '+%F %T')] ✅ 隧道正常 ($CURRENT_URL)" >> "$LOG_FILE"
        exit 0
    fi

    # ---------- 4. URL 变了（新隧道）→ 同步 Cloudflare Pages（staging + production 双项目） ----------
    echo "[$(date '+%F %T')] 🔄 隧道 URL 变化: $(cat "$URL_FILE" 2>/dev/null) → $CURRENT_URL" >> "$LOG_FILE"
    echo "$CURRENT_URL" > "$URL_FILE"

    echo "[$(date '+%F %T')]   更新 Cloudflare 变量 LM_BASE_URL（staging + production）…" >> "$LOG_FILE"
    export PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
    for PROJ in ai-detective-staging ai-detective-game; do
        echo "$CURRENT_URL/v1" | wrangler pages secret put LM_BASE_URL --project-name "$PROJ" >> "$LOG_FILE" 2>&1
    done

    # 脏工作区保护（V1.1）：production 部署前检查 git 状态。
    # 若 public/ functions/ cases/ 有未提交改动，说明正在开发中——只同步 staging，跳过 production
    # （防止半成品代码在隧道重启时被自动部署上线，违反 staging 先行红线）
    cd /Users/rc/project/new/ai-detective || exit 1
    DIRTY=$(git status --porcelain -- public/ functions/ cases/ 2>/dev/null | wc -l | tr -d ' ')
    DEPLOY_PROJS="ai-detective-staging"
    if [ "$DIRTY" = "0" ]; then
        DEPLOY_PROJS="ai-detective-staging ai-detective-game"
        echo "[$(date '+%F %T')] ✅ 工作区干净，同步 staging + production" >> "$LOG_FILE"
    else
        echo "[$(date '+%F %T')] ⚠️ 工作区有 $DIRTY 处未提交改动（开发中）→ 仅同步 staging，跳过 production" >> "$LOG_FILE"
    fi

    echo "[$(date '+%F %T')]   重新部署 Cloudflare Pages（$DEPLOY_PROJS）…" >> "$LOG_FILE"
    ALL_OK=1
    for PROJ in $DEPLOY_PROJS; do
        PROJ_DOMAIN="$PROJ.pages.dev"
        DEPLOY_OK=0
        for attempt in 1 2 3; do
            if wrangler pages deploy public --project-name "$PROJ" --commit-dirty=true 2>&1 | tee -a "$LOG_FILE" | grep -q "Deployment complete"; then
                DEPLOY_OK=1
                # 部署后验证 chat 链路（同步接口，直接等模型回复；secret 传播可能有延迟）
                sleep 3
                VRES=$(curl -s --max-time 120 -X POST "https://$PROJ_DOMAIN/api/chat" \
                    -H "Content-Type: application/json" \
                    -d '{"case_id":"manor","suspect_id":"butler","question":"你好","history":[],"owned_clues":[],"mode":"normal"}')
                VERIFY_OK=0
                if echo "$VRES" | grep -q '"reply"'; then
                    VERIFY_OK=1
                fi
                if [ "$VERIFY_OK" = "1" ]; then
                    echo "[$(date '+%F %T')] ✅ $PROJ 已同步新隧道地址（chat 验证通过）" >> "$LOG_FILE"
                    break
                fi
                echo "[$(date '+%F %T')] ⚠️ $PROJ 部署后 chat 验证失败（第 $attempt 次）: $(echo "$VRES" | head -c 120)" >> "$LOG_FILE"
                sleep 10
            else
                echo "[$(date '+%F %T')] ⚠️ $PROJ 部署失败（第 $attempt 次）！" >> "$LOG_FILE"
                sleep 10
            fi
        done
        if [ "$DEPLOY_OK" != "1" ]; then
            ALL_OK=0
        fi
    done
    if [ "$ALL_OK" != "1" ]; then
        # 同步未全部通过：**不**更新 current_url，下次运行会重新触发同步（避免永久跳过）
        echo "[$(date '+%F %T')] ⚠️ 双项目同步未全部通过，保留旧 URL 待下次重试" >> "$LOG_FILE"
        rm -f "$URL_FILE"
    fi
else
    echo "[$(date '+%F %T')] ❌ 隧道探测失败 (HTTP $HTTP_CODE)，尝试重启 cloudflared" >> "$LOG_FILE"
    pkill -f "cloudflared tunnel --url http://localhost:1234"
    sleep 2
    nohup "$CLOUDFLARED" tunnel --url http://localhost:1234 --no-autoupdate >> "$LOG_FILE" 2>&1 &
fi

exit 0
