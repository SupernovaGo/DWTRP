"""
运行环境管理（可选组件）
===========================
本项目的**必需依赖只有 requirements.txt**（FastAPI 后端 + BM25 关键词检索）。
向量检索所需的 `torch` + `sentence-transformers` 与嵌入模型文件都是可选组件，
体积很大，默认不安装、不入库。

这里提供「设置 → 运行环境」用到的能力：
  * `status()`                —— 解释器、依赖、模型缓存的状态快照
  * `start_install_embedding()` —— 后台 pip 安装 requirements-embedding.txt
  * `start_download_model()`    —— 后台下载嵌入模型到 HuggingFace 缓存
  * `current_task()` / `cancel_task()` —— 轮询进度与取消

安装/下载都跑在子进程里，日志实时回传，不阻塞前端对话。
"""
import os
import subprocess
import sys
import threading
import time
import uuid

import embedding
from i18n import tr
from settings import BASE_DIR, CONFIG, read_embedding_config

_ROOT = os.path.dirname(BASE_DIR)
MAX_LOG_LINES = 300

_LOCK = threading.Lock()
_TASK = {
    "id": "",
    "kind": "",          # "" | "install_embedding" | "download_model"
    "state": "idle",     # idle | running | done | failed | cancelled
    "detail": "",
    "log": [],
    "started_at": 0.0,
    "ended_at": 0.0,
}
_PROC = {"proc": None}


def _requirements(name: str) -> str:
    return os.path.join(_ROOT, name)


def python_info() -> dict:
    return {
        "executable": sys.executable,
        "version": ".".join(str(v) for v in sys.version_info[:3]),
        "major_minor": f"{sys.version_info.major}.{sys.version_info.minor}",
        "in_venv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
        "prefix": sys.prefix,
        "platform": sys.platform,
    }


def status(refresh: bool = False) -> dict:
    """给前端用的完整状态：解释器 + 可选依赖 + 模型缓存 + 当前任务。"""
    embed = embedding.status(refresh=refresh)
    cfg_raw = read_embedding_config()
    return {
        "python": python_info(),
        "requirements": os.path.exists(_requirements("requirements-embedding.txt")),
        "embedding": embed,
        "config": {
            "enabled": cfg_raw["enabled"],
            "offline": cfg_raw["offline"],
            "model_name": cfg_raw["model_name"],
            "hf_endpoint": cfg_raw["hf_endpoint"],
            "pip_index_url": cfg_raw["pip_index_url"],
        },
        "task": current_task(),
    }


def current_task() -> dict:
    with _LOCK:
        return {
            "id": _TASK["id"],
            "kind": _TASK["kind"],
            "state": _TASK["state"],
            "detail": _TASK["detail"],
            "log": _TASK["log"][-MAX_LOG_LINES:],
            "started_at": _TASK["started_at"],
            "ended_at": _TASK["ended_at"],
            "running": _TASK["state"] == "running",
        }


def _begin(kind: str, detail: str) -> str:
    with _LOCK:
        if _TASK["state"] == "running":
            raise RuntimeError(tr("已有环境任务正在进行，请等它结束或先取消"))
        task_id = uuid.uuid4().hex[:12]
        _TASK.update(id=task_id, kind=kind, state="running", detail=detail,
                     log=[], started_at=time.time(), ended_at=0.0)
        _PROC["proc"] = None
        return task_id


def _log(line: str) -> None:
    line = (line or "").rstrip()
    if not line:
        return
    with _LOCK:
        _TASK["log"].append(line)
        if len(_TASK["log"]) > MAX_LOG_LINES * 2:
            del _TASK["log"][:MAX_LOG_LINES]


def _finish(state: str, detail: str = "") -> None:
    with _LOCK:
        _TASK["state"] = state
        _TASK["ended_at"] = time.time()
        if detail:
            _TASK["detail"] = detail
        _PROC["proc"] = None
    # 安装/下载完成后让依赖探测与共享嵌入器重新评估。
    embedding.deps_installed(refresh=True)
    embedding.forget_shared_embedder()


def _pump(proc: subprocess.Popen) -> int:
    """把子进程输出实时写进任务日志，返回退出码。"""
    assert proc.stdout is not None
    for line in iter(proc.stdout.readline, ""):
        _log(line)
    proc.stdout.close()
    return proc.wait()


def _run(kind: str, cmd: list, detail: str, env_extra: dict = None) -> str:
    task_id = _begin(kind, detail)
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    if env_extra:
        env.update(env_extra)
    _log("$ " + " ".join(str(c) for c in cmd))

    def worker():
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=_ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as e:  # noqa: BLE001
            _finish("failed", tr("无法启动子进程：{err}", err=e))
            return
        with _LOCK:
            _PROC["proc"] = proc
        code = _pump(proc)
        if current_task()["state"] == "cancelled":
            return
        if code == 0:
            _finish("done", tr("完成"))
        else:
            _finish("failed", tr("子进程退出码 {code}", code=code))

    threading.Thread(target=worker, daemon=True).start()
    return task_id


# ---------- 可选依赖安装 ----------
def _pip_args(index_url: str = "") -> list:
    args = [sys.executable, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check"]
    cfg_args = CONFIG.get("ENV_PIP_ARGS") or []
    args += [str(a) for a in cfg_args]
    url = (index_url or CONFIG.get("ENV_PIP_INDEX_URL") or "").strip()
    if url:
        args += ["-i", url]
    return args


def start_install_embedding(index_url: str = "", packages: list = None) -> str:
    """后台安装 torch + sentence-transformers（默认整个 requirements-embedding.txt）。"""
    args = _pip_args(index_url)
    if packages:
        args += [str(p) for p in packages]
    else:
        req = _requirements("requirements-embedding.txt")
        if os.path.exists(req):
            args += ["-r", req]
        else:  # 缺文件时退回到显式包名
            args += ["torch", "sentence-transformers"]
    return _run("install_embedding", args, tr("正在安装 torch + sentence-transformers…"))


# ---------- 嵌入模型下载 ----------
def start_download_model(model_name: str = "", mirror: str = "") -> str:
    """后台下载嵌入模型到 HuggingFace 缓存（离线开关临时关闭）。"""
    script = os.path.join(_ROOT, "scripts", "fetch_embedding_model.py")
    model = (model_name or CONFIG.get("EMBEDDING_MODEL_NAME") or "").strip()
    cmd = [sys.executable, script]
    if model:
        cmd += ["--model", model]
    endpoint = (mirror or CONFIG.get("ENV_HF_ENDPOINT") or "").strip()
    if endpoint:
        cmd += ["--endpoint", endpoint]
    return _run(
        "download_model", cmd,
        tr("正在下载嵌入模型 {model}…", model=model or tr('(默认)')),
        env_extra={
            "HF_HUB_OFFLINE": "0",
            "TRANSFORMERS_OFFLINE": "0",
            "PYTHONPATH": BASE_DIR + os.pathsep + os.environ.get("PYTHONPATH", ""),
        },
    )


def cancel_task() -> dict:
    with _LOCK:
        proc = _PROC.get("proc")
        running = _TASK["state"] == "running"
    if not running:
        return {"ok": False, "detail": tr("当前没有正在进行的任务")}
    if proc is None:
        return {"ok": False, "detail": tr("任务正在启动中，请稍后再试")}
    try:
        proc.terminate()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "detail": str(e)}
    _log(tr("[已请求取消任务]"))
    _finish("cancelled", tr("已取消"))
    return {"ok": True}
