#!/bin/bash
# WAIC 2026 日程助手 一键部署：构建数据 + 打包 skill + rsync 上传
# 用法：SERVER=user@host REMOTE_PATH=/var/www/waic/ bash scripts/deploy.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${SERVER:-}"
REMOTE_PATH="${REMOTE_PATH:-/var/www/waic/}"

echo "====== WAIC 2026 日程助手 · 部署 ======"

echo "[1/3] 构建数据..."
python3 "$ROOT/scripts/build.py"

echo "[2/3] 打包 skill..."
bash "$ROOT/scripts/package-skill.sh"

if [ -z "$SERVER" ]; then
  echo "[3/3] 未设置 SERVER，跳过上传。产物在 $ROOT/build-output/"
  echo "  设置后重跑：SERVER=user@host bash scripts/deploy.sh"
  exit 0
fi

echo "[3/3] rsync 上传到 $SERVER:$REMOTE_PATH ..."
rsync -avz --delete --exclude='.DS_Store' "$ROOT/build-output/" "$SERVER:$REMOTE_PATH"

echo "====== ✓ 部署完成 ======"
curl -fsSL --max-time 5 "https://waic.sg.superbrain-ai.com/VERSION" && echo " ← 服务器 VERSION 正常" || echo "⚠ VERSION 获取失败，检查 DNS/SSL"
