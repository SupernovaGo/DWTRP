"""
嵌入工具（可选依赖）
===========================
向量检索依赖 `torch` + `sentence-transformers`（体积数 GB）与嵌入模型文件，
因此它们**不属于必需依赖**：

  * 未安装依赖、未下载模型、或用户在设置里关闭了「向量检索」时，
    `Embedder()` 会抛出 `EmbeddingUnavailable`，记忆检索自动退回 BM25 关键词匹配；
  * 安装与下载可在「设置 → 运行环境」一键完成，或运行
    `python scripts/setup_env.py --embedding --download-model`。

离线开关（config.toml 的 `[embedding] offline`）：默认 `true`，模型只从本地缓存加载，
避免网络受限时 HuggingFace 反复重试导致“卡在正在回应”。首次下载模型时由
`scripts/fetch_embedding_model.py` 临时关闭离线再拉取。
"""
import os
import threading

import numpy as np

from settings import CONFIG, read_embedding_config


class EmbeddingUnavailable(RuntimeError):
    """嵌入能力不可用（依赖未安装 / 模型未下载 / 已在设置中关闭 / 加载失败）。"""


# 依赖探测比较慢（import torch），缓存结果；安装完成后可传 refresh=True 重新探测。
_deps_cache: dict = {"checked": False, "ok": False, "torch": "", "st": "", "error": ""}
_deps_lock = threading.Lock()


def deps_installed(refresh: bool = False) -> bool:
    """torch + sentence-transformers 是否可用（不加载模型）。"""
    with _deps_lock:
        if _deps_cache["checked"] and not refresh:
            return bool(_deps_cache["ok"])
        ok, torch_v, st_v, err = False, "", "", ""
        try:
            import torch  # noqa: PLC0415
            import sentence_transformers  # noqa: PLC0415

            torch_v = getattr(torch, "__version__", "")
            st_v = getattr(sentence_transformers, "__version__", "")
            ok = True
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
        _deps_cache.update(checked=True, ok=ok, torch=torch_v, st=st_v, error=err)
        return ok


def hf_cache_dirs() -> list:
    """HuggingFace 缓存目录候选（新建在前，与 huggingface_hub 的解析顺序一致）。"""
    dirs = []
    for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        value = os.environ.get(key)
        if value:
            dirs.append(value)
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        dirs.append(os.path.join(hf_home, "hub"))
    dirs.append(os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub"))
    out = []
    for d in dirs:
        if d and d not in out:
            out.append(d)
    return out


def model_cache_path(model_name: str) -> str:
    """返回模型已缓存的目录；未缓存时返回空串（不导入 torch，仅看目录）。"""
    if not model_name:
        return ""
    folder = "models--" + model_name.replace("/", "--")
    for base in hf_cache_dirs():
        path = os.path.join(base, folder)
        snapshots = os.path.join(path, "snapshots")
        if os.path.isdir(snapshots) and os.listdir(snapshots):
            return path
    return ""


def resolve_local_model(model_name: str) -> str:
    """把模型名解析成**本地快照目录**（取最新的一份），找不到返回空串。

    离线模式下直接把本地目录交给 sentence-transformers，可完全避免
    HuggingFace 联网查元数据 → 网络受限时不会卡住。

    同一个模型可能存在多份快照（例如某次下载中断留下的残片），因此优先选择
    `refs/main` 指向、且包含 `modules.json` / `config.json` 的完整快照。
    """
    if not model_name:
        return ""
    if os.path.isdir(model_name):
        return model_name
    cached = model_cache_path(model_name)
    if not cached:
        return ""
    snapshots_dir = os.path.join(cached, "snapshots")
    try:
        revs = [s for s in os.listdir(snapshots_dir)
                if os.path.isdir(os.path.join(snapshots_dir, s))]
    except OSError:
        return ""
    if not revs:
        return ""

    ref = ""
    try:
        with open(os.path.join(cached, "refs", "main"), encoding="utf-8") as f:
            ref = f.read().strip()
    except OSError:
        pass

    def score(rev: str) -> tuple:
        path = os.path.join(snapshots_dir, rev)
        try:
            files = set(os.listdir(path))
            mtime = os.path.getmtime(path)
        except OSError:
            files, mtime = set(), 0.0
        complete = 1 if ({"config.json"} & files) else 0
        usable = 1 if ({"modules.json"} & files) else 0
        return (1 if rev == ref and usable else 0, usable, complete, mtime)

    revs.sort(key=score, reverse=True)
    best = os.path.join(snapshots_dir, revs[0])
    return best


def apply_offline_env(offline: bool) -> None:
    """设置 HF 离线开关与镜像地址（下载模型时会临时关闭离线）。"""
    cfg = read_embedding_config()
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        if offline:
            os.environ[key] = "1"
        else:
            os.environ.pop(key, None)
    endpoint = cfg.get("hf_endpoint") or ""
    if endpoint:
        os.environ["HF_ENDPOINT"] = endpoint


# 进程内共享的嵌入器：加载一次模型，多个会话/角色复用。
_shared: dict = {"embedder": None, "loading": False, "error": ""}
_shared_lock = threading.Lock()


def status(refresh: bool = False) -> dict:
    """给「设置 → 运行环境」用的状态快照。"""
    cfg = read_embedding_config()
    installed = deps_installed(refresh=refresh)
    cached = model_cache_path(cfg["model_name"])
    return {
        "enabled": cfg["enabled"],
        "offline": cfg["offline"],
        "model_name": cfg["model_name"],
        "deps_installed": installed,
        "torch_version": _deps_cache["torch"],
        "sentence_transformers_version": _deps_cache["st"],
        "deps_error": "" if installed else _deps_cache["error"],
        "model_cached": bool(cached),
        "model_path": cached,
        "hf_home": os.environ.get("HF_HOME", ""),
        "hf_endpoint": cfg.get("hf_endpoint", ""),
        "ready": bool(cfg["enabled"] and installed and cached),
        "loaded": _shared["embedder"] is not None,
        "last_error": _shared["error"],
    }


def get_shared_embedder() -> "Embedder":
    """返回进程内共享的嵌入器（首次调用时加载模型，失败抛 EmbeddingUnavailable）。"""
    with _shared_lock:
        if _shared["embedder"] is None:
            _shared["loading"] = True
            try:
                _shared["embedder"] = Embedder(shared=True)
                _shared["error"] = ""
            except EmbeddingUnavailable as e:
                _shared["error"] = str(e)
                raise
            finally:
                _shared["loading"] = False
        return _shared["embedder"]


def forget_shared_embedder() -> None:
    """释放共享模型（配置改动或安装新依赖后调用，下次检索时再重新加载）。"""
    with _shared_lock:
        _shared["embedder"] = None
        _shared["error"] = ""


class Embedder:
    def __init__(self, model_name: str = None, dim: int = None, offline: bool = None,
                 shared: bool = False):
        cfg = read_embedding_config()
        self.dim = int(dim or cfg["dim"] or CONFIG["EMBEDDING_DIM"])
        self.model_name = model_name or cfg["model_name"] or CONFIG["EMBEDDING_MODEL_NAME"]
        self.shared = bool(shared)
        if not cfg["enabled"]:
            raise EmbeddingUnavailable(
                "已在设置中关闭向量检索（config.toml 的 [embedding] enabled = false）")
        if not deps_installed():
            raise EmbeddingUnavailable(
                "未安装 torch / sentence-transformers，无法使用向量检索；"
                "可在「设置 → 运行环境」安装，或继续使用 BM25 关键词检索")
        offline = cfg["offline"] if offline is None else bool(offline)
        apply_offline_env(offline)
        # 离线模式：直接用本地缓存里的快照目录，绝不发起网络请求。
        target = self.model_name
        if offline and not os.path.isdir(target):
            target = resolve_local_model(self.model_name)
            if not target:
                raise EmbeddingUnavailable(
                    f"本地未找到嵌入模型 {self.model_name}；"
                    "请在「设置 → 运行环境」里下载，或把 [embedding] offline 设为 false 后联网加载")
        try:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(target)
        except Exception as e:  # noqa: BLE001
            raise EmbeddingUnavailable(f"加载嵌入模型 {self.model_name} 失败：{e}") from e
        # 查询向量缓存：同一回合多个角色检索的是同一玩家输入，避免重复前向计算。
        self._query_cache = {}
        self._query_cache_limit = 512

    def embed_texts(self, texts) -> np.ndarray:
        texts = list(texts)
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        return self._model.encode(
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
            batch_size=64,
        ).astype(np.float32)

    def embed_one(self, text: str) -> np.ndarray:
        key = hash(str(text))
        cached = self._query_cache.get(key)
        if cached is not None:
            return cached
        vec = self.embed_texts([str(text)])[0]
        if len(self._query_cache) < self._query_cache_limit:
            self._query_cache[key] = vec
        return vec
