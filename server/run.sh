#!/usr/bin/env bash
# 启动 WAIC 日程助手后端。
# 依赖环境变量 TOKENHUB_API_KEY（服务器由 systemd 注入；本地测试见 README）。
set -euo pipefail
cd "$(dirname "$0")"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8790}"
WORKERS="${WORKERS:-1}"

if [[ -z "${TOKENHUB_API_KEY:-}" ]]; then
  echo "[warn] TOKENHUB_API_KEY 未设置：/api/chat 会返回 error 事件，其余只读接口仍可用。" >&2
fi

# 优先用本目录 venv（若存在）
if [[ -x ".venv/bin/uvicorn" ]]; then
  UVICORN=".venv/bin/uvicorn"
else
  UVICORN="uvicorn"
fi

exec "$UVICORN" app:app --host "$HOST" --port "$PORT" --workers "$WORKERS"
