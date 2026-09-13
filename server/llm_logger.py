"""
调用日志
==============
把每一次 LLM 调用的完整 prompt（system + user）和模型的原始返回、解析结果，
以及关键运行事件，写入日志，便于事后分析。

日志按**会话**组织，目录结构：data/logs/<session_id>/<kind>_YYYY-MM-DD.jsonl
无会话的全局调用（默认 / 会话切换前的初始化等）写入 data/logs/ 根目录，作为兜底。
"""
import datetime
import json
import os
import re

from settings import CONFIG


# request_id -> session_id：在一次会话回合开始时登记，供深层 LLM 调用回溯。
_REQUEST_SESSION = {}


def _log_dir(session_id: str | None = None) -> str:
    root = os.path.join(CONFIG["DATA_DIR"], "logs")
    if session_id:
        return os.path.join(root, str(session_id))
    return root


def set_request_session(request_id: str, session_id: str):
    """登记一个回合的 request_id 属于哪个会话，供 __main__ 深层的 LLM 调用定位。"""
    if request_id:
        _REQUEST_SESSION[request_id] = session_id


def _resolve_session(session_id: str | None, request_id: str | None) -> str | None:
    if session_id:
        return session_id
    if request_id:
        return _REQUEST_SESSION.get(request_id)
    return None


def _write(kind: str, entry: dict, session_id: str | None = None,
           request_id: str | None = None):
    sid = _resolve_session(session_id, request_id)
    d = _log_dir(sid)
    os.makedirs(d, exist_ok=True)
    today = datetime.date.today().isoformat()
    path = os.path.join(d, f"{kind}_{today}.jsonl")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def log_llm_call(request_id: str, agent: str, messages: list,
                 raw: str, parsed: dict | None = None,
                 error: str | None = None, extra: dict | None = None,
                 session_id: str | None = None):
    """记录一次 LLM 调用：完整 messages + 原始返回 + 解析结果。"""
    entry = {
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "request_id": request_id,
        "agent": agent,
        "messages": messages,
        "raw": raw or "",
        "parsed": parsed,
        "error": error,
    }
    if extra:
        entry.update(extra)
    _write("llm", entry, session_id=session_id, request_id=request_id)


def log_event(request_id: str, kind: str, payload: dict,
              session_id: str | None = None):
    """记录一次关键运行事件（角色解析、环境变化、错误提示等）。"""
    entry = {
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "request_id": request_id,
        "kind": kind,
        **payload,
    }
    _write("events", entry, session_id=session_id, request_id=request_id)


_DATE_RE = re.compile(r"_(\d{4}-\d{2}-\d{2})\.jsonl$")


def cleanup_old_logs(days: int = None):
    """按保留天数清理过期的会话日志文件。

    days 为空时读取配置 LOG_RETENTION_DAYS；<=0 表示不清理（永久保留）。
    默认只保留最近 3 天。文件名格式：<kind>_YYYY-MM-DD.jsonl。
    """
    from settings import CONFIG
    if days is None:
        days = int(CONFIG.get("LOG_RETENTION_DAYS", 3) or 3)
    if days <= 0:
        return 0
    root = os.path.join(CONFIG["DATA_DIR"], "logs")
    cutoff = datetime.date.today() - datetime.timedelta(days=days)
    removed = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            m = _DATE_RE.search(name)
            if not m:
                continue
            try:
                fdate = datetime.date.fromisoformat(m.group(1))
            except ValueError:
                continue
            if fdate < cutoff:
                try:
                    os.remove(os.path.join(dirpath, name))
                    removed += 1
                except OSError:
                    pass
    # 顺手清理已空的会话日志目录（保留根目录）
    for name in list(os.listdir(root)) if os.path.isdir(root) else []:
        d = os.path.join(root, name)
        if os.path.isdir(d) and not os.listdir(d):
            try:
                os.rmdir(d)
            except OSError:
                pass
    return removed
