#!/bin/bash
# WAIC 2026 参展助手 · 确定性刷新→构建→门禁→原子发布→飞书
# 全程无 AI。任一步失败或门禁不过 → 保留线上旧数据 + 飞书告警。
# 到 STOP_DATE（含）之后自动摘除自身 cron 并退出。
#
# 环境变量（可选）：
#   WEBROOT              线上 web 根，默认 /var/www/waic
#   WAIC_FEISHU_WEBHOOK  飞书群自定义机器人 webhook
#   WAIC_FEISHU_SECRET   机器人签名密钥（若开启签名）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 从 .env 读飞书 webhook 等，避免写进 crontab
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
WEBROOT="${WEBROOT:-/var/www/waic}"
STOP_DATE="2026-07-20"
PY="${PY:-python3}"
LOG="$ROOT/build-output/refresh.log"
notify() { "$PY" "$ROOT/scripts/feishu_notify.py" "$1" >>"$LOG" 2>&1 || true; }
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

# 防重叠（论坛详情全量拉取可达 8 分钟）
exec 9>"$ROOT/.refresh.lock"
flock -n 9 || { log "已有实例在跑，跳过本次"; exit 0; }

TODAY="$(date +%F)"
if [[ "$TODAY" > "$STOP_DATE" ]]; then
  log "已过 $STOP_DATE，停止定时更新并摘除 cron。"
  ( crontab -l 2>/dev/null | grep -v 'refresh_and_deploy.sh' | crontab - ) 2>/dev/null || true
  exit 0
fi

log "====== 刷新开始 ======"

# 1. 拉源（0=全成功 2=部分失败但旧数据保留；都继续。1=致命）
"$PY" "$ROOT/scripts/refresh.py" >>"$LOG" 2>&1
rc=$?
if [[ $rc -eq 1 ]]; then log "refresh 致命失败"; notify failed; exit 1; fi

# 1.5 Tier4 资讯采集（公网+公众号搜 WAIC 新闻 → raw/web/articles.json → build 并入 intel）。
#     降级安全：失败只记日志，绝不 block 数据管线。
"$PY" "$ROOT/scripts/fetch_intel.py" >>"$LOG" 2>&1 || log "⚠ fetch_intel 失败，本轮跳过资讯采集"

# 2. 构建
if ! "$PY" "$ROOT/scripts/build.py" >>"$LOG" 2>&1; then
  log "build 失败"; notify failed; exit 1
fi

# 3. 健康门禁
if ! "$PY" "$ROOT/scripts/validate.py" >>"$LOG" 2>&1; then
  log "门禁未过，禁止发布"; notify failed; exit 1
fi

# 3.5 Tier5 每日日报（随每轮刷新更新；放在"无变化跳过"之前——数据没变，日期也会翻）
if "$PY" "$ROOT/scripts/make_digest.py" >>"$LOG" 2>&1; then
  cp -f "$ROOT/build-output/digest-latest.json" "$WEBROOT/digest-latest.json" 2>/dev/null || true
  if [[ -n "${PUSH_TO:-}" ]]; then
    rsync -az -e "${PUSH_SSH:-ssh}" "$ROOT/build-output/digest-latest.json" "$PUSH_TO/digest-latest.json" >>"$LOG" 2>&1 || log "⚠ digest 推 SG 失败"
  fi
  [[ -n "${POST_DEPLOY_DIGEST:-}" ]] && { eval "$POST_DEPLOY_DIGEST" >>"$LOG" 2>&1 || log "⚠ digest 镜像失败"; }
else
  log "⚠ make_digest 失败，本轮跳过日报"
fi

# 4. 无变化则不打扰（比对 activities.json 校验和）
SHACMD="$(command -v sha256sum || command -v shasum)"
NEW_SHA="$($SHACMD "$ROOT/build-output/data/activities.json" 2>/dev/null | awk '{print $1}')"
OLD_SHA="$(cat "$ROOT/build-output/.last_deployed_sha" 2>/dev/null || echo none)"
if [[ "$NEW_SHA" == "$OLD_SHA" ]]; then
  log "数据无变化，跳过发布。"; exit 0
fi

# 4.5 数据分层（v2 2026-07-16）：公开层只发精简索引，全量只进 AI 后端私有目录。
#     make_light 剥离 schedule/guests/description_en/全文等重字段 → build-output/data-lite/
if ! "$PY" "$ROOT/scripts/make_light.py" >>"$LOG" 2>&1; then
  log "make_light 失败，禁止发布（避免全量数据发到公开层）"; notify failed; exit 1
fi
# 防泄露门禁：精简层里绝不允许出现 schedule/guests 字段（回归即拦截）
if grep -q '"schedule"\|"guests"' "$ROOT/build-output/data-lite/activities.json" 2>/dev/null; then
  log "❌ 分层门禁：data-lite 仍含 schedule/guests，禁止发布"; notify failed; exit 1
fi
# bundle 重打为精简版（build.py 产的是全量 bundle，不能对外）：索引层 + VERSION + md/unofficial
TMPB="$(mktemp -d)"; mkdir -p "$TMPB/data" "$TMPB/md"
cp "$ROOT"/build-output/data-lite/*.json "$TMPB/data/" 2>/dev/null || true
cp "$ROOT/build-output/VERSION" "$TMPB/" 2>/dev/null || true
[[ -d "$ROOT/build-output/md/unofficial" ]] && cp -r "$ROOT/build-output/md/unofficial" "$TMPB/md/"
tar czf "$ROOT/build-output/bundle.tar.gz" -C "$TMPB" . 2>>"$LOG" || true
rm -rf "$TMPB"

# 4.6 全量 → 本机 AI 后端私有层（.env 配 PRIVATE_DATA；南京=/home/backdeploy/apps/waic-api/data，
#     SG=/opt/waic-api/data），并重启 waic-api 加载新数据。未配则跳过。
if [[ -n "${PRIVATE_DATA:-}" ]]; then
  sudo -n mkdir -p "$PRIVATE_DATA" 2>/dev/null || mkdir -p "$PRIVATE_DATA" 2>/dev/null || true
  if sudo -n rsync -rlptD "$ROOT/build-output/data/" "$PRIVATE_DATA/" >>"$LOG" 2>&1 \
     || rsync -rlptD "$ROOT/build-output/data/" "$PRIVATE_DATA/" >>"$LOG" 2>&1; then
    sudo -n systemctl restart waic-api >>"$LOG" 2>&1 && log "私有层已更新 + waic-api 已重启" \
      || log "⚠ waic-api 重启失败（新数据要等下次重启才生效）"
  else
    log "⚠ 私有层 $PRIVATE_DATA 更新失败（本机 AI 将继续用旧数据）"
  fi
fi

# 5. 原子发布（先备份线上，再整目录替换 data —— 公开层只放精简索引 data-lite）
if [[ -d "$WEBROOT/data" ]]; then
  rm -rf "$WEBROOT/data.bak" 2>/dev/null || true
  cp -a "$WEBROOT/data" "$WEBROOT/data.bak" 2>/dev/null || true
fi
STAGE="$WEBROOT/data.staging.$$"
cp -a "$ROOT/build-output/data-lite" "$STAGE"
rm -rf "$WEBROOT/data.old" 2>/dev/null || true
[[ -d "$WEBROOT/data" ]] && mv "$WEBROOT/data" "$WEBROOT/data.old"
mv "$STAGE" "$WEBROOT/data"
cp -a "$ROOT/build-output/VERSION" "$WEBROOT/VERSION" 2>/dev/null || true
cp -a "$ROOT/build-output/bundle.tar.gz" "$WEBROOT/bundle.tar.gz" 2>/dev/null || true
rm -rf "$WEBROOT/data.old" 2>/dev/null || true

# 每日数据快照（保留 7 天，源数据异常时可回滚）
SNAP="$ROOT/snapshots/$(date +%F)"
if [[ ! -d "$SNAP" ]]; then
  mkdir -p "$SNAP" && cp -a "$ROOT/build-output/data" "$SNAP/" 2>/dev/null || true
  find "$ROOT/snapshots" -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
fi

echo "$NEW_SHA" > "$ROOT/build-output/.last_deployed_sha"
"$PY" - "$ROOT" <<'PYEOF'
import json,sys
root=sys.argv[1]
vr=json.load(open(f"{root}/build-output/validate_report.json"))
json.dump({"counts":vr.get("counts",{}),"ts":__import__("time").strftime("%F %T")},
          open(f"{root}/build-output/.last_good.json","w"),ensure_ascii=False)
PYEOF

# 6. 推送到远端主站（南京做主时，PUSH_TO 指向 SG webroot —— 公开层只推精简索引）
if [[ -n "${PUSH_TO:-}" ]]; then
  RS="${PUSH_SSH:-ssh}"
  if rsync -az --delete -e "$RS" "$ROOT/build-output/data-lite/" "$PUSH_TO/data/" >>"$LOG" 2>&1 \
     && rsync -az -e "$RS" "$ROOT/build-output/VERSION" "$ROOT/build-output/bundle.tar.gz" "$PUSH_TO/" >>"$LOG" 2>&1; then
    log "已推送到 $PUSH_TO（索引层）"
    # 6b. 全量 → 远端 AI 后端私有层（.env 配 PUSH_TO_PRIVATE，如 ubuntu@SG:/opt/waic-api/data），
    #     并远程重启 waic-api。远端主站的 AI 才能拿到最新全量。
    if [[ -n "${PUSH_TO_PRIVATE:-}" ]]; then
      RHOST="${PUSH_TO_PRIVATE%%:*}"
      if rsync -az -e "$RS" "$ROOT/build-output/data/" "$PUSH_TO_PRIVATE/" >>"$LOG" 2>&1; then
        $RS "$RHOST" 'sudo -n systemctl restart waic-api' >>"$LOG" 2>&1 \
          && log "远端私有层已更新 + waic-api 已重启" || log "⚠ 远端 waic-api 重启失败"
      else
        log "⚠ 远端私有层推送失败（远端 AI 将继续用旧数据）"
        rm -f "$ROOT/build-output/.last_deployed_sha"   # 强制下次重推
      fi
    fi
  else
    log "⚠ 推送到 $PUSH_TO 失败（本地镜像已更新）"
    rm -f "$ROOT/build-output/.last_deployed_sha"   # 强制下次重推，避免远端永久滞后
  fi
fi

# 7. 部署后钩子（南京用它 sudo 更新本地镜像 /var/www/sites/waic）
if [[ -n "${POST_DEPLOY:-}" ]]; then
  if eval "$POST_DEPLOY" >>"$LOG" 2>&1; then log "POST_DEPLOY 完成"; else log "⚠ POST_DEPLOY 失败"; fi
fi

log "====== 发布成功 VERSION=$(cat "$WEBROOT/VERSION" 2>/dev/null) ======"
notify deployed
exit 0
