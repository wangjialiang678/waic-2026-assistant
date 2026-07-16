#!/bin/bash
# 南京服务器：飞书「小课堂」→ superbrain.html → 部署 SG 主站 + 南京镜像
# 每 20 分钟 cron。用 OpenClaw app token 读飞书（.env 里 FEISHU_APP_ID/SECRET）。
# 到 2026-07-20 结束后自摘 cron。
#
# 设计要点（v3，2026-07-16 第二次 review 后）：
# - flock 防重叠。
# - 推送基准 = 「上次成功推送的内容 sha」（.agenda_pushed_sha），而不是本地文件是否变化——
#   这样若某次推 SG 失败，下次即使飞书没再改，也会自动补推，SG 不会永久滞后。
# - v3 新增「以 SG 线上文件为基底」：superbrain.html 有两个写入方（本管线写议程块 / Mac UI 侧
#   deploy 整页），各自持有旧副本互相覆盖。现在每轮先拉 SG 线上最新页面做基底，再往里替换
#   SB_AGENDA 块 → UI 更新自动被吸收、议程永远叠加在最新页面上，双向 ≤20 分钟自愈。
set -uo pipefail
ROOT="$HOME/waic-refresh"
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
HTML="$ROOT/webroot/superbrain.html"
LOG="$ROOT/build-output/sync_agenda.log"
PUSHED="$ROOT/build-output/.agenda_pushed_sha"
log(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 防重叠
exec 9>"$ROOT/.agenda.lock"
flock -n 9 || exit 0

# 20 号当天照跑，21 号起停并自摘 cron
if [[ "$(date +%F)" > "2026-07-20" ]]; then
  log "已过 7/20，议程同步停止并摘 cron。"
  ( crontab -l 2>/dev/null | grep -v 'sync_agenda_server_deploy.sh' | crontab - ) 2>/dev/null || true
  exit 0
fi

# 0. 以 SG 线上最新页面为基底（吸收 UI 侧的页面更新；拉不到就沿用本地副本）
if curl -fsSL --max-time 15 "https://waic.sg.superbrain-ai.com/superbrain.html" -o "$HTML.base" 2>>"$LOG" \
   && grep -q 'const SB_AGENDA' "$HTML.base"; then
  mv "$HTML.base" "$HTML"
else
  rm -f "$HTML.base"; log "⚠ 拉 SG 线上基底失败，沿用本地副本"
fi

# 1. 从飞书同步进本地 webroot（rc=0 有变化 / 3 无变化 / 其他=失败）
python3 "$ROOT/scripts/sync_agenda_server.py" --html "$HTML" >>"$LOG" 2>&1
rc=$?
if [[ $rc -ne 0 && $rc -ne 3 ]]; then log "同步失败 rc=$rc（读飞书/门禁），不部署。"; exit 1; fi

# 2. 与「上次成功推送」比对；不一致就推（覆盖飞书有变化 + 上次推送失败两种情况）
SHACMD="$(command -v sha256sum || command -v shasum)"
CUR="$($SHACMD "$HTML" | awk '{print $1}')"
[[ "$CUR" == "$(cat "$PUSHED" 2>/dev/null)" ]] && exit 0

NJ2SG="ssh -p 799 -i $HOME/.ssh/nanjing_to_sg -o StrictHostKeyChecking=accept-new"
ok=1
rsync -az -e "$NJ2SG" "$HTML" ubuntu@101.32.248.235:/var/www/waic/superbrain.html >>"$LOG" 2>&1 \
  && log "✓ 议程已推 SG 主站" || { log "⚠ 推 SG 失败（下次自动补推）"; ok=0; }
sudo -n cp -f "$HTML" /var/www/sites/waic/superbrain.html \
  && log "✓ 议程已更新南京镜像" || { log "⚠ 南京镜像更新失败（下次自动补推）"; ok=0; }
[[ $ok -eq 1 ]] && echo "$CUR" > "$PUSHED"
log "====== 议程同步完成（pushed=$ok）======"
