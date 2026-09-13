#!/usr/bin/env bash
# DWTRP 环境准备（macOS / Linux）：创建 .venv、安装必需依赖，可选安装向量检索依赖与模型。
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONIOENCODING=utf-8

PY="${DWTRP_BOOTSTRAP_PYTHON:-}"
if [ -z "$PY" ]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
  done
fi

if [ -z "$PY" ]; then
  echo "[ERROR] 未找到 Python，请先安装 Python 3.11+： https://www.python.org/downloads/" >&2
  exit 1
fi

echo "使用的 Python：$PY（$("$PY" -V 2>&1)）"
exec "$PY" scripts/setup_env.py "$@"
