#!/bin/bash
# WAIC 2026 参展助手 · 两层部署（数据分层保护）
#   全量（含议程/嘉宾/全文）→ 服务端私有 /opt/waic-api/data + /opt/waic-api/md（仅 /api/* 和 AI 聊天可取）
#   精简（索引层）        → 公开 /var/www/waic/（客户端浏览/搜索；详情走 /api/activity/{id}）
# 用法：SERVER=ubuntu@host SSH_OPTS="-p 799 -i ~/.ssh/tc_deploy_key" bash scripts/deploy.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${SERVER:-}"
REMOTE_PATH="${REMOTE_PATH:-/var/www/waic/}"
PRIVATE_DATA="${PRIVATE_DATA:-/opt/waic-api/data/}"
PRIVATE_MD="${PRIVATE_MD:-/opt/waic-api/md/}"
SSH_OPTS="${SSH_OPTS:-}"

echo "====== WAIC 2026 参展助手 · 两层部署 ======"

echo "[1/5] 构建全量数据..."
python3 "$ROOT/scripts/build.py"

echo "[2/5] 生成精简索引层 (make_light)..."
python3 "$ROOT/scripts/make_light.py"

echo "[3/5] 打精简 bundle（索引层 + VERSION + md/unofficial；不含官方议程 md）..."
TMP="$(mktemp -d)"; mkdir -p "$TMP/data" "$TMP/md"
cp "$ROOT"/build-output/data-lite/*.json "$TMP/data/"
cp "$ROOT"/build-output/VERSION "$TMP/" 2>/dev/null || true
[ -d "$ROOT/build-output/md/unofficial" ] && cp -r "$ROOT/build-output/md/unofficial" "$TMP/md/"
tar czf "$ROOT/build-output/bundle.tar.gz" -C "$TMP" .
rm -rf "$TMP"

if [ -z "$SERVER" ]; then
  echo "[4-5/5] 未设置 SERVER，跳过上传。产物：build-output/（公开层用 data-lite/）"
  exit 0
fi

echo "[4/5] 全量 → 服务端私有 $PRIVATE_DATA / $PRIVATE_MD ..."
ssh $SSH_OPTS "$SERVER" "mkdir -p $PRIVATE_DATA $PRIVATE_MD"
rsync -az -e "ssh $SSH_OPTS" "$ROOT/build-output/data/" "$SERVER:$PRIVATE_DATA"
rsync -az -e "ssh $SSH_OPTS" "$ROOT/build-output/md/"   "$SERVER:$PRIVATE_MD"

echo "[5/5] 精简 → 公开 $REMOTE_PATH（data 用 data-lite；不发全量 data/ 与官方议程 md/agenda）..."
rsync -avz --delete -e "ssh $SSH_OPTS" --exclude='.DS_Store' \
  --exclude='data/' --exclude='data-lite/' --exclude='md/agenda/' \
  "$ROOT/build-output/" "$SERVER:$REMOTE_PATH"
rsync -az --delete -e "ssh $SSH_OPTS" "$ROOT/build-output/data-lite/" "$SERVER:${REMOTE_PATH}data/"

echo "====== ✓ 两层部署完成 ======"
echo "提示：服务端 systemd 需 WAIC_DATA_DIR=$PRIVATE_DATA（已配置则无需改）。"
curl -fsSL --max-time 5 "https://waic.sg.superbrain-ai.com/VERSION" && echo " ← 服务器 VERSION 正常" || echo "⚠ VERSION 获取失败"
