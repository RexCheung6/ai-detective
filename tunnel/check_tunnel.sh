#!/bin/bash
# ============================================================
# AI 侦探 · 隧道守护脚本
# 职责：
#   1. 检查 cloudflared 进程，不在则启动
#   2. 探测隧道可用性（带 API key，401 = 在线且有认证 = 正常）
#   3. 隧道 URL 变化时，自动更新 Netlify LM_BASE_URL 并重新部署
# 由 launchd 每 120 秒调用一次
# ============================================================

export PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

CLOUDFLARED="$HOME/bin/cloudflared"
LOG_FILE="/Users/rc/project/new/ai-detective/tunnel/cloudflared.log"
URL_FILE="/Users/rc/project/new/ai-detective/tunnel/current_url"
LM_API_KEY="[REDACTED]"
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

    # ---------- 4. URL 变了（新隧道）→ 同步 Cloudflare Pages ----------
    echo "[$(date '+%F %T')] 🔄 隧道 URL 变化: $(cat "$URL_FILE" 2>/dev/null) → $CURRENT_URL" >> "$LOG_FILE"
    echo "$CURRENT_URL" > "$URL_FILE"

    echo "[$(date '+%F %T')]   更新 Cloudflare 变量 LM_BASE_URL…" >> "$LOG_FILE"
    export PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
    echo "$CURRENT_URL/v1" | wrangler pages secret put LM_BASE_URL --project-name ai-detective-game >> "$LOG_FILE" 2>&1

    echo "[$(date '+%F %T')]   重新部署 Cloudflare Pages…" >> "$LOG_FILE"
    cd /Users/rc/project/new/ai-detective || exit 1
    if wrangler pages deploy public --project-name ai-detective-game --commit-dirty=true 2>&1 | tee -a "$LOG_FILE" | grep -q "Deployment complete"; then
        echo "[$(date '+%F %T')] ✅ Cloudflare Pages 已同步新隧道地址" >> "$LOG_FILE"
    else
        echo "[$(date '+%F %T')] ⚠️ Cloudflare Pages 部署失败！请检查上方日志" >> "$LOG_FILE"
        echo "$CURRENT_URL" > "$URL_FILE"
    fi
else
    echo "[$(date '+%F %T')] ❌ 隧道探测失败 (HTTP $HTTP_CODE)，尝试重启 cloudflared" >> "$LOG_FILE"
    pkill -f "cloudflared tunnel --url http://localhost:1234"
    sleep 2
    nohup "$CLOUDFLARED" tunnel --url http://localhost:1234 --no-autoupdate >> "$LOG_FILE" 2>&1 &
fi

exit 0
