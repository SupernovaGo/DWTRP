"""
运行时提示词存储
======================
把各 Agent 的系统提示词抽成可编辑的数据，而不是写死在代码里。
首次访问时用 prompts.py / memory_summarizer 里的默认值生成
data/prompts.json，之后前端读写本文件即可持久化修改。
"""
import json
import os
import hashlib

from prompts import (
    PLAYER_SYSTEM,
    ENVIRONMENT_SYSTEM,
    FRONTEND_SYSTEM,
    ASSIST_SYSTEM,
    STORY_SYSTEM,
    CHARACTER_MEMORY_SYSTEM,
    CHARACTER_PLAN_SYSTEM,
    WORLD_UPDATE_SYSTEM,
    MEMORY_SUMMARY_SYSTEM,
    MEMORY_PLANNER_SYSTEM,
    SESSION_INIT_SYSTEM,
)
from settings import CONFIG


# 各 Agent 系统提示词默认值（与旧版一致，作为兜底）
DEFAULTS = {
    "player": PLAYER_SYSTEM,
    "environment": ENVIRONMENT_SYSTEM,
    "frontend": FRONTEND_SYSTEM,
    "assist": ASSIST_SYSTEM,
    "story": STORY_SYSTEM,
    "character_memory": CHARACTER_MEMORY_SYSTEM,
    "character_plan": CHARACTER_PLAN_SYSTEM,
    "world_update": WORLD_UPDATE_SYSTEM,
    "memory_summary": MEMORY_SUMMARY_SYSTEM,
    "memory_planner": MEMORY_PLANNER_SYSTEM,
    "session_init": SESSION_INIT_SYSTEM,
}


def _path() -> str:
    return os.path.join(CONFIG["DATA_DIR"], "prompts.json")


def _code_hash() -> str:
    """代码里 DEFAULTS 的指纹：DEFAULTS 一旦在 prompts.py 里被改动，指纹即变化。"""
    return hashlib.sha256(
        json.dumps(DEFAULTS, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]


def _write(prompts: dict):
    os.makedirs(CONFIG["DATA_DIR"], exist_ok=True)
    data = dict(prompts)
    data["__version__"] = _code_hash()
    with open(_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_prompts() -> dict:
    """读取全部系统提示词；若文件不存在或代码 DEFAULTS 已变化则用默认值重新初始化。"""
    result = dict(DEFAULTS)
    if os.path.exists(_path()):
        try:
            with open(_path(), encoding="utf-8") as f:
                data = json.load(f)
            file_version = data.get("__version__")
            if file_version == _code_hash():
                # 代码未变：采用文件里（用户在设置页）改动过的提示词。
                for key in DEFAULTS:
                    value = data.get(key)
                    if isinstance(value, str) and value.strip():
                        result[key] = value
            else:
                # 代码里的 DEFAULTS 变了：以代码为准，重建文件。
                _write(result)
        except (json.JSONDecodeError, ValueError):
            _write(result)
            pass
    else:
        _write(result)
    return result


def save_prompts(prompts: dict):
    _write(prompts)


def get_prompt(key: str) -> str:
    return load_prompts().get(key, DEFAULTS.get(key, ""))


def set_prompt(key: str, text: str):
    prompts = load_prompts()
    prompts[key] = text
    save_prompts(prompts)
