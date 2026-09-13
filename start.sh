#!/usr/bin/env bash
# TRPE 启动脚本（macOS / Linux）：必要时构建前端，然后启动后端并托管 web/dist。
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
export PYTHONIOENCODING=utf-8

PY="${TRPE_PYTHON:-}"
if [ -z "$PY" ]; then
  for candidate in ".venv/bin/python" "python3" "python"; do
    if [ -x "$candidate" ] || command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
  done
fi

if [ -z "$PY" ]; then
  echo "[ERROR] 未找到 Python，请先运行 ./setup.sh 准备环境。" >&2
  exit 1
fi

if ! "$PY" -c "import fastapi, uvicorn, numpy, jieba, rank_bm25, requests, tomli_w" >/dev/null 2>&1; then
  echo "[ERROR] 缺少必需依赖，请先运行： ./setup.sh" >&2
  exit 1
fi

if command -v npm >/dev/null 2>&1; then
  set +e
  "$PY" scripts/check_frontend.py
  need_build=$?
  set -e
  if [ "$need_build" -ne 0 ]; then
    [ -d web/node_modules ] || (cd web && npm install)
    (cd web && npm run build)
  fi
elif [ ! -f web/dist/index.html ]; then
  echo "[WARN] 未找到 npm，且 web/dist 不存在：界面将无法打开。" >&2
  echo "       请安装 Node.js 后重新运行 start.sh，或使用仓库自带的 web/dist。" >&2
fi

HOST="${TRPE_HOST:-0.0.0.0}"
PORT="${TRPE_PORT:-8000}"
echo "启动后端： http://127.0.0.1:$PORT （Ctrl+C 停止）"
exec "$PY" server/main.py --host "$HOST" --port "$PORT" "$@"
