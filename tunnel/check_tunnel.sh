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
NETLIFY_SITE="271cc547-ad13-4f35-9001-9c12028a0d41"  # ai-detective-game-828 的 site ID
LM_API_KEY="[REDACTED]"
mkdir -p "/Users/rc/project/new/ai-detective/tunnel"

# 注意：不设 NETLIFY_AUTH_TOKEN —— launchd 用户 agent 可访问 keychain，
# 而 token 模式会导致 netlify-cli 不读取 netlify.toml 的 functions 配置（函数丢失）

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

    # ---------- 4. URL 变了（新隧道）→ 同步 Netlify ----------
    echo "[$(date '+%F %T')] 🔄 隧道 URL 变化: $(cat "$URL_FILE" 2>/dev/null) → $CURRENT_URL" >> "$LOG_FILE"
    echo "$CURRENT_URL" > "$URL_FILE"

    echo "[$(date '+%F %T')]   更新 Netlify LM_BASE_URL…" >> "$LOG_FILE"
    netlify env:set LM_BASE_URL "$CURRENT_URL/v1" --site "$NETLIFY_SITE" >> "$LOG_FILE" 2>&1

    echo "[$(date '+%F %T')]   重新部署…" >> "$LOG_FILE"
    cd /Users/rc/project/new/ai-detective || exit 1
    if netlify deploy --build --prod --skip-functions-cache 2>&1 | tee -a "$LOG_FILE" | grep -q "Deploy complete"; then
        echo "[$(date '+%F %T')] ✅ Netlify 已同步新隧道地址" >> "$LOG_FILE"
    else
        echo "[$(date '+%F %T')] ⚠️ Netlify 部署失败（可能构建额度用完）。网页版需在额度恢复后手动同步。" >> "$LOG_FILE"
        # 保留最新 URL 记录，额度恢复后重试时能检测到差异
        echo "$CURRENT_URL" > "$URL_FILE"
    fi
else
    echo "[$(date '+%F %T')] ❌ 隧道探测失败 (HTTP $HTTP_CODE)，尝试重启 cloudflared" >> "$LOG_FILE"
    pkill -f "cloudflared tunnel --url http://localhost:1234"
    sleep 2
    nohup "$CLOUDFLARED" tunnel --url http://localhost:1234 --no-autoupdate >> "$LOG_FILE" 2>&1 &
fi

exit 0
