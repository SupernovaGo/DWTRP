"""
配置加载
"""
import os
import tomllib

try:
    from dotenv import dotenv_values, load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None
    dotenv_values = None


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, ".env")

if load_dotenv is not None:
    # 优先加载 ./server/.env，便于存放 DEEPSEEK_API_KEY 等私有变量。
    load_dotenv(ENV_PATH)


def _load_raw():
    with open(os.path.join(BASE_DIR, "config.toml"), "rb") as f:
        return tomllib.load(f)


_RAW = _load_raw()
_P = _RAW["paths"]
_W = _RAW["world"]
_E = _RAW["embedding"]
_L = _RAW["llm"]
_M = _RAW["memory"]
_F = _RAW["frontend"]
_U = _RAW.get("update", {})
_S = _RAW.get("server", {})
_LOGS = _RAW.get("logs", {})
_SNAP = _RAW.get("snapshot", {})
_SESS = _RAW.get("session", {})
_ENV = _RAW.get("env", {})


def _time_list(value):
    """把 world_update_time / character_update_time 统一成列表，兼容单个字符串。"""
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()]
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    return []

DATA_DIR = os.path.join(BASE_DIR, _P["data_dir"])
STATE_DIR = os.path.join(DATA_DIR, _P["state_dir"])
CHARACTER_STATES_DIR = os.path.join(STATE_DIR, _P["character_states_dir"])
MEMORY_DIR = os.path.join(STATE_DIR, _P["memory_dir"])


def _join(base: str, rel: str) -> str:
    return os.path.join(base, rel)


def _deep_merge(base: dict, patch: dict) -> dict:
    """递归深合并：patch 中的值覆盖 base；list/标量直接覆盖。"""
    result = dict(base)
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _build_config(raw: dict) -> dict:
    P = raw["paths"]
    W = raw["world"]
    E = raw["embedding"]
    L = raw["llm"]
    M = raw.get("memory", {})
    F = raw["frontend"]
    U = raw.get("update", {})
    S = raw.get("server", {})
    LOGS = raw.get("logs", {})
    SNAP = raw.get("snapshot", {})
    SESS = raw.get("session", {})
    ENV = raw.get("env", {})
    data_dir = os.path.join(BASE_DIR, P["data_dir"])
    state_dir = os.path.join(data_dir, P["state_dir"])
    cfg = {
    # 路径
    "BASE_DIR": BASE_DIR,
    "DATA_DIR": data_dir,
    "STATE_DIR": state_dir,
    "CHARACTER_STATES_DIR": os.path.join(state_dir, P["character_states_dir"]),
    "MEMORY_DIR": os.path.join(state_dir, P["memory_dir"]),
    "WORLDBOOK_PATH": _join(data_dir, P["worldbook_file"]),
    "USER_IDENTITY_PATH": _join(data_dir, P["user_identity_file"]),
    "CORE_CHARACTERS_DIR": _join(data_dir, P["core_characters_dir"]),
    "GENERAL_CHARACTERS_PATH": _join(data_dir, P["general_characters_file"]),
    "WORLD_STATE_PATH": _join(state_dir, P["world_state_file"]),
    "TIMELINE_PATH": _join(state_dir, P["timeline_file"]),
    "PLAYER_PERCEPTION_PATH": _join(state_dir, P["player_perception_file"]),

    # 世界
    "TIMEZONE": W["timezone"],
    "START_TIME": W["start_time"],
    "ENABLE_MANUAL_TIME_ADVANCE": bool(W.get("enable_manual_time_advance", True)),
    "DEFAULT_ADVANCE_MINUTES": int(W["default_advance_minutes"]),
    "WORLD_SUMMARY_MAX_CHARS": int(W["world_summary_max_chars"]),
    "CHARACTER_SUMMARY_MAX_CHARS": int(W["character_summary_max_chars"]),
    "PLAYER_CHARACTER_DETAIL": str(W.get("player_character_detail", "full") or "full"),
    "CORE_ONLY_UPDATE": bool(W.get("core_only_update", False)),
    "SCENE_HISTORY_LIMIT": int(W.get("scene_history_limit", 24) or 24),
    "WORLDBOOK_ENTRY_DEPTH": int(W.get("world_entry_depth", 2)),
    "WORLDBOOK_ENTRY_MAX": int(W.get("world_entry_max", 4)),

    # 存档点
    "SNAPSHOT_INTERVAL": int(SNAP.get("interval", 0)),
    "SNAPSHOT_MAX": int(SNAP.get("max", 20)),
    "REWIND_MAX_TURNS": int(SNAP.get("rewind_max_turns", 10)),

    # 会话
    "AUTO_CREATE_DEFAULT_SESSION": bool(SESS.get("auto_create_default", True)),
    "DEFAULT_STARTER_CHARACTERS": int(SESS.get("starter_characters", 8)),
    "DEFAULT_STARTER_WORLDBOOKS": int(SESS.get("starter_worldbooks", 1)),

    # 嵌入
    "EMBEDDING_MODEL_NAME": E["model_name"],
    "EMBEDDING_DIM": int(E["dim"]),
    # 嵌入/向量检索是可选能力：关闭或缺少依赖时会自动退回 BM25 关键词检索。
    "EMBEDDING_ENABLED": bool(E.get("enabled", True)),
    "EMBEDDING_OFFLINE": bool(E.get("offline", True)),

    # 记忆
    "MAX_MEMORY_EVENTS": int(M["max_events"]),
    "FORGET_CHECK_EVERY_K_TURNS": int(M["forget_check_every_k_turns"]),
    "TIME_DECAY": float(M["time_decay"]),
    "IMPORTANCE_BUMP": float(M["importance_bump"]),
    "TOP_EVENTS": int(M["top_events"]),
    "MAX_CONTEXT_CHARS": int(M["max_context_chars"]),
    "WORKING_MEMORY_LIMIT": int(M["working_memory_limit"]),
    "WORKING_MEMORY_KEEP_CHARS": int(M["working_memory_keep_chars"]),
    "MIN_SUMMARIZE_CHARS": int(M["min_summarize_chars"]),
    "WORKING_SUMMARIZE_RATIO": float(M.get("working_summarize_ratio", 0.5)),
    "WORKING_SUMMARY_MODE": str(M.get("working_summary_mode", "ratio") or "ratio"),
    "AGENTIC_RETRIEVAL": bool(M.get("agentic_retrieval", False)),
    "MAX_RETRIEVAL_ROUNDS": int(M.get("max_retrieval_rounds", 3)),
    "RETRIEVAL_CANDIDATES": int(M.get("retrieval_candidates", 16)),
    "RETRIEVAL_EMBED_WEIGHT": float(M.get("retrieval_embedding_weight", 0.6)),
    "RETRIEVAL_BM25_WEIGHT": float(M.get("retrieval_bm25_weight", 0.4)),
    "RETRIEVAL_RELEVANCE_WEIGHT": float(M.get("relevance_weight", 0.60)),
    "RETRIEVAL_IMPORTANCE_WEIGHT": float(M.get("importance_weight", 0.20)),
    "RETRIEVAL_RECENCY_WEIGHT": float(M.get("recency_weight", 0.20)),

    # 前台渲染
    "THOUGHT_VISIBLE_BY_DEFAULT": bool(F["thought_visible_by_default"]),

    # 世界/角色更新
    "UPDATE_TIME": _time_list(U.get("time", "12:00")),
    "UPDATE_WORLD_FIRST": bool(U.get("world_first", True)),
    "UPDATE_BATCH_SIZE": int(U.get("batch_size", 10)),
    "UPDATE_MAX_WORKERS": int(U.get("max_workers", 8) or 8),
    "UPDATE_NOTICE": bool(U.get("notice", True)),
    "UPDATE_ENABLE_MANUAL_UPDATE": bool(U.get("enable_manual_update", True)),

    # 服务
    "SERVER_HOST": S.get("host", "127.0.0.1"),
    "SERVER_PORT": int(S.get("port", 8000)),
    "SERVER_CORS_ORIGINS": list(S.get("cors_origins", [])),

    # 日志保留
    "LOG_RETENTION_DAYS": int(LOGS.get("retention_days", 3) or 3),

    # 运行环境（可选依赖安装 / 模型下载）
    "ENV_PIP_ARGS": list(ENV.get("pip_args", []) or []),
    "ENV_PIP_INDEX_URL": str(ENV.get("pip_index_url", "") or ""),
    "ENV_HF_ENDPOINT": str(ENV.get("hf_endpoint", "") or ""),
}
    cfg["LLM"] = {
        "api_base": L.get("api_base", "https://api.deepseek.com/chat/completions"),
        "api_key_env": L.get("api_key_env", "DEEPSEEK_API_KEY"),
        "request_timeout": int(L.get("request_timeout", 240)),
        "retries": int(L.get("retries", 3)),
    }
    cfg["LLM_AGENTS"] = {
        name: {
            "model": value.get("model", "deepseek-v4-flash"),
            "temperature": float(value.get("temperature", 0.7)),
            "max_tokens": int(value.get("max_tokens", 2048)),
            "thinking": bool(value.get("thinking", False)),
            "reasoning_effort": value.get("reasoning_effort", "low"),
        }
        for name, value in L.items()
        if isinstance(value, dict)
    }
    return cfg


CONFIG = _build_config(_RAW)
_SESSION_OVERRIDE: dict = {}


def apply_session_override(override: dict | None) -> None:
    """应用某个会话的配置覆盖（形状同 config.toml：world/memory/llm/...）。

    全局 config.toml 作为底座，会话覆盖叠加在其上；WorldSession 在初始化/切换会话时调用，
    时间线、检索权重等改变会在内存中立即生效（无需重启）。
    """
    global _SESSION_OVERRIDE, _RAW
    # 每次都重新读取全局 config.toml，保证全局设置页的改动不会被旧的 _RAW 覆盖。
    try:
        _RAW = _load_raw()
    except Exception:  # noqa: BLE001
        pass
    _SESSION_OVERRIDE = override or {}
    merged = _deep_merge(_RAW, _SESSION_OVERRIDE)
    new_cfg = _build_config(merged)
    CONFIG.clear()
    CONFIG.update(new_cfg)
    # 重建后补回 API Key（LLMClient 依赖 CONFIG["DEEPSEEK_API_KEY"]）。
    CONFIG["DEEPSEEK_API_KEY"] = find_api_key()


def find_api_key() -> str:
    """实时解析 API Key，优先级：环境变量 → server/.env → config.toml 的 [llm].api_key。

    这里刻意**每次都重新解析**（.env 按修改时间缓存，开销极小），原因：
      * 用户手动编辑 server/.env 后无需重启服务即可生效；
      * 环境变量存在但为**空字符串**时（`set X=` 之后很常见）不再遮蔽 .env 里的真 Key。
    """
    env_name = _api_key_env_name()
    key = (os.environ.get(env_name) or "").strip()
    if key:
        return key
    key = (dotenv_file_values().get(env_name) or "").strip()
    if key:
        return key
    return str(((_RAW.get("llm") or {}).get("api_key")) or "").strip()


def _api_key_env_name() -> str:
    llm = CONFIG.get("LLM") if isinstance(CONFIG.get("LLM"), dict) else None
    if llm and llm.get("api_key_env"):
        return str(llm["api_key_env"])
    return str(((_RAW.get("llm") or {}).get("api_key_env")) or "DEEPSEEK_API_KEY")


_DOTENV_CACHE: dict = {"mtime": None, "values": {}}


def _parse_env_file(path: str) -> dict:
    """没有 python-dotenv 时的最简 .env 解析（KEY=VALUE，支持 # 注释与引号）。"""
    values = {}
    try:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                values[name.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        return {}
    return values


def dotenv_file_values() -> dict:
    """解析 server/.env（按文件修改时间缓存），不依赖 os.environ 是否被设置过。"""
    try:
        mtime = os.path.getmtime(ENV_PATH)
    except OSError:
        return {}
    if _DOTENV_CACHE["mtime"] != mtime:
        values: dict = {}
        if dotenv_values is not None:
            try:
                values = {k: (v or "") for k, v in (dotenv_values(ENV_PATH) or {}).items()}
            except Exception:  # noqa: BLE001
                values = _parse_env_file(ENV_PATH)
        else:
            values = _parse_env_file(ENV_PATH)
        _DOTENV_CACHE.update(
            mtime=mtime,
            values={str(k): str(v).strip() for k, v in values.items() if v is not None},
        )
    return _DOTENV_CACHE["values"]


def api_key_source() -> str:
    """API Key 的来源：'env' / '.env' / 'config.toml' / ''（未配置）。"""
    env_name = _api_key_env_name()
    if (os.environ.get(env_name) or "").strip():
        return "env"
    if (dotenv_file_values().get(env_name) or "").strip():
        return ".env"
    if str(((_RAW.get("llm") or {}).get("api_key")) or "").strip():
        return "config.toml"
    return ""


CONFIG["DEEPSEEK_API_KEY"] = find_api_key()


def read_player_char_detail() -> str:
    """实时读取「玩家角色信息详细度」，让设置开关无需重启即可对玩家 Agent 生效。"""
    try:
        with open(os.path.join(BASE_DIR, "config.toml"), "rb") as f:
            data = tomllib.load(f)
        world = data.get("world") or {}
    except Exception:  # noqa: BLE001
        world = {}
    if isinstance(_SESSION_OVERRIDE.get("world"), dict):
        world = {**world, **_SESSION_OVERRIDE["world"]}
    return str(world.get("player_character_detail", "full") or "full")


def read_core_only_update() -> bool:
    """实时读取「仅核心角色更新」开关，让设置无需重启即可生效。"""
    try:
        with open(os.path.join(BASE_DIR, "config.toml"), "rb") as f:
            data = tomllib.load(f)
        world = data.get("world") or {}
    except Exception:  # noqa: BLE001
        world = {}
    if isinstance(_SESSION_OVERRIDE.get("world"), dict):
        world = {**world, **_SESSION_OVERRIDE["world"]}
    return bool(world.get("core_only_update", False))


def read_memory_retrieval() -> dict:
    """实时读取「记忆检索权重」，让设置页改完即可生效，无需重启。"""
    try:
        with open(os.path.join(BASE_DIR, "config.toml"), "rb") as f:
            data = tomllib.load(f)
        m = data.get("memory") or {}
    except Exception:  # noqa: BLE001
        m = {}
    if isinstance(_SESSION_OVERRIDE.get("memory"), dict):
        m = {**m, **_SESSION_OVERRIDE["memory"]}
    return {
        "embed_weight": float(m.get("retrieval_embedding_weight", 0.6)),
        "bm25_weight": float(m.get("retrieval_bm25_weight", 0.4)),
        "relevance_weight": float(m.get("relevance_weight", 0.60)),
        "importance_weight": float(m.get("importance_weight", 0.20)),
        "recency_weight": float(m.get("recency_weight", 0.20)),
    }


def read_embedding_config() -> dict:
    """实时读取 [embedding] / [env]，让「启用向量检索」「模型名」「HF 镜像」改完即生效。"""
    try:
        with open(os.path.join(BASE_DIR, "config.toml"), "rb") as f:
            data = tomllib.load(f)
    except Exception:  # noqa: BLE001
        data = {}
    e = data.get("embedding") or {}
    env = data.get("env") or {}
    return {
        "enabled": bool(e.get("enabled", True)),
        "offline": bool(e.get("offline", True)),
        "model_name": str(e.get("model_name") or CONFIG["EMBEDDING_MODEL_NAME"]),
        "dim": int(e.get("dim") or CONFIG["EMBEDDING_DIM"]),
        "pip_index_url": str(env.get("pip_index_url") or ""),
        "hf_endpoint": str(env.get("hf_endpoint") or ""),
    }


def ensure_dirs():
    """确保标准数据目录存在，方便直接放入标准格式的数据文件后刷新即可看到。"""
    os.makedirs(CONFIG["DATA_DIR"], exist_ok=True)
    # 记忆与角色状态只隶属于某个会话（data/sessions/<id>/ 下的
    # memory/、character_states/、world_state.json 等），不再创建全局 data/state。
    for sub in ("characters", "worldbooks", "identities", "sessions", "logs"):
        os.makedirs(os.path.join(CONFIG["DATA_DIR"], sub), exist_ok=True)
