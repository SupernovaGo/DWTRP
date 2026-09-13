"""
后端服务
===========
FastAPI 入口：把世界引擎包成 JSON 接口，聊天用 SSE 流式推送。
提供会话管理、玩家身份卡、世界书编辑等全局能力。

运行：
  python main.py            # 开发，默认 http://127.0.0.1:8000
"""
import argparse
import asyncio
import json
import os
import socket
import subprocess
from contextlib import asynccontextmanager

import tomllib
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from settings import CONFIG, ENV_PATH, api_key_source, ensure_dirs, find_api_key
from sessions import SessionManager
from prompts_store import load_prompts, set_prompt
import player_identities as identities
import character_library
import worldbook_library
import card_schema


_MANAGER = None


def mock_enabled() -> bool:
    """是否处于离线 mock 模式（只有明确设为 1/true/yes 才算）。"""
    return os.environ.get("MOCK", "0").strip().lower() in ("1", "true", "yes", "on")


def get_manager() -> SessionManager:
    global _MANAGER
    if _MANAGER is None:
        _MANAGER = SessionManager(mock=mock_enabled())
    return _MANAGER


def get_session():
    try:
        return get_manager().get_world_session()
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    # 不强制要求当前会话（空白开场）：仅初始化资源库与会话索引。
    get_manager()
    yield


app = FastAPI(title="TRPE", version="0.3.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CONFIG["SERVER_CORS_ORIGINS"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- 工具 ----------
def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _read_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _cfg_raw() -> dict:
    path = os.path.join(CONFIG["BASE_DIR"], "config.toml")
    with open(path, "rb") as f:
        return tomllib.load(f)


def _cfg_write(data: dict):
    import tomli_w
    path = os.path.join(CONFIG["BASE_DIR"], "config.toml")
    with open(path, "wb") as f:
        tomli_w.dump(data, f)


# ---------- 聊天 ----------
class ChatRequest(BaseModel):
    text: str
    segments: list[dict] | None = None


@app.post("/api/chat")
def chat(req: ChatRequest):
    try:
        return get_session().handle_player_input(req.text, req.segments)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()
    session = get_session()
    sentinel = object()

    def push(event: dict):
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def runner():
        try:
            session._on_event = push
            result = await asyncio.to_thread(session.handle_player_input, req.text, req.segments)
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)
            return result
        except Exception as e:  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)
            return {"error": str(e)}
        finally:
            session._on_event = None

    async def gen():
        task = asyncio.create_task(runner())
        while True:
            item = await queue.get()
            if item is sentinel:
                break
            yield _sse(item)
        result = await task
        if "error" in result:
            yield _sse({"type": "error", "text": result["error"]})
        else:
            yield _sse({"type": "turn_end",
                        "player_message": result["player_message"],
                        "state": result["state"]})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------- 状态 ----------
@app.get("/api/state")
def get_state():
    return get_session().snapshot_state()


class PerceptionBody(BaseModel):
    time: str | None = None
    weather: str | None = None
    location: str | None = None
    details: list[str] | None = None
    scene_characters: list[dict] | None = None


@app.put("/api/session/perception")
def put_perception(body: PerceptionBody):
    session = get_session()
    session.world.apply_perception({
        "time": body.time,
        "weather": body.weather,
        "location": body.location,
        "details": body.details,
        "scene_characters": body.scene_characters,
    })
    session._save_meta()
    return {"ok": True, "state": session.snapshot_state()}


@app.post("/api/session/perception/advance")
def advance_perception():
    session = get_session()
    session.world.advance_time()
    session._save_meta()
    return {"ok": True, "state": session.snapshot_state()}


class ManualUpdateBody(BaseModel):
    target: str = "world"


@app.post("/api/session/manual-update")
def manual_update(body: ManualUpdateBody):
    session = get_session()
    # 手动更新改为后台执行并立即返回，避免阻塞前台输入；结果通过 pending_updates 轮询消费。
    session.request_manual_update(body.target)
    return {"ok": True, "state": session.snapshot_state()}


@app.post("/api/session/manual-update/stream")
async def manual_update_stream(body: ManualUpdateBody):
    session = get_session()
    # 手动更新改为后台执行并立即返回一个 turn_end；进度/结果由状态轮询与 pending_updates 提供。
    session.request_manual_update(body.target)

    async def gen():
        yield _sse({"type": "turn_end", "state": session.snapshot_state()})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ThinkBody(BaseModel):
    value: bool


@app.post("/api/session/pending-updates/ack")
def ack_pending_updates():
    session = get_session()
    session.ack_updates()
    return {"ok": True}


@app.post("/api/state/think")
def toggle_think(body: ThinkBody):
    session = get_session()
    session.show_thought = body.value
    session._save_meta()
    return {"show_thought": session.show_thought}


class StoryModeBody(BaseModel):
    enabled: bool


@app.post("/api/session/story-mode")
def set_story_mode(body: StoryModeBody):
    session = get_session()
    session.story_mode = bool(body.enabled)
    session._save_meta()
    return {"ok": True, "story_mode": session.story_mode, "state": session.snapshot_state()}


class AssistBody(BaseModel):
    mode: str = "write"


@app.post("/api/assist")
def assist(body: AssistBody):
    session = get_session()
    return session.assist(body.mode or "write")


@app.post("/api/assist/rewind")
def assist_rewind():
    session = get_session()
    return session.rewind_last_turn()


@app.post("/api/assist/rewind/stream")
async def assist_rewind_stream():
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()
    session = get_session()
    sentinel = object()

    def push(event: dict):
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def runner():
        try:
            session._on_event = push
            result = await asyncio.to_thread(session.rewind_last_turn)
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)
            return result
        except Exception as e:  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)
            return {"error": str(e)}
        finally:
            session._on_event = None

    async def gen():
        task = asyncio.create_task(runner())
        while True:
            item = await queue.get()
            if item is sentinel:
                break
            yield _sse(item)
        result = await task
        if "error" in result:
            yield _sse({"type": "error", "text": result["error"]})
        else:
            yield _sse({
                "type": "turn_end",
                "player_message": result.get("player_message"),
                "state": result.get("state"),
            })

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/session/save")
def save_session():
    get_session().save_session()
    return {"ok": True}


@app.post("/api/session/reset")
def reset_session():
    import shutil
    sid = get_manager().active_id()
    if not sid:
        raise HTTPException(status_code=409, detail="尚无当前会话")
    rdir = get_manager().sessions_dir_of(sid)
    if rdir and os.path.isdir(rdir):
        for name in ("world_state.json", "timeline.json", "player_perception.json",
                     "session.json", "memory", "character_states"):
            p = os.path.join(rdir, name)
            if os.path.isdir(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)
    get_manager().invalidate()
    return get_session().snapshot_state()


# ---------- 会话 ----------
@app.get("/api/sessions")
def list_sessions():
    mgr = get_manager()
    return {"sessions": mgr.list_sessions(), "active_id": mgr.active_id()}


class RenameBody(BaseModel):
    name: str


@app.put("/api/sessions/{sid}")
def rename_session(sid: str, body: RenameBody):
    mgr = get_manager()
    entry = mgr.rename(sid, body.name)
    if not entry:
        raise HTTPException(status_code=404, detail="会话不存在或名称为空")
    return {"ok": True, "session": entry}


class SessionCreate(BaseModel):
    name: str
    hint: str = ""
    worldbooks: list[str] = []
    characters: list[str] = []
    identity_id: str = ""


@app.post("/api/sessions")
def create_session(body: SessionCreate):
    mgr = get_manager()
    entry = mgr.create(body.name, body.worldbooks, body.characters,
                       body.identity_id, body.hint)
    return {"ok": True, "session": entry}


@app.post("/api/sessions/{sid}/initialize")
def initialize_session(sid: str, body: SessionCreate):
    mgr = get_manager()
    if not mgr.get_session(sid):
        raise HTTPException(status_code=404, detail="会话不存在")
    return mgr.initialize(sid, body.hint)


class StartBody(BaseModel):
    init: dict


@app.post("/api/sessions/{sid}/start")
def start_session(sid: str, body: StartBody):
    mgr = get_manager()
    if not mgr.get_session(sid):
        raise HTTPException(status_code=404, detail="会话不存在")
    return mgr.start(sid, body.init)


@app.post("/api/sessions/{sid}/switch")
def switch_session(sid: str):
    mgr = get_manager()
    if not mgr.get_session(sid):
        raise HTTPException(status_code=404, detail="会话不存在")
    mgr.set_active(sid)
    return {"ok": True, "state": get_session().snapshot_state()}


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str):
    mgr = get_manager()
    ok = mgr.delete(sid)
    if not ok:
        raise HTTPException(status_code=400, detail="默认会话不可删")
    return {"ok": True, "state": get_session().snapshot_state()}


# ---------- 会话历史（编辑 / 删除 / 从此重开）----------
class HistoryEdit(BaseModel):
    index: int
    text: str


@app.put("/api/session/history/{index}")
def edit_history(index: int, body: HistoryEdit):
    session = get_session()
    if index < 0 or index >= len(session.scene_history):
        raise HTTPException(status_code=404, detail="历史条目不存在")
    session.scene_history[index] = body.text
    # 编辑玩家消息后同步重写快照：让重写遵循编辑后的内容。
    close = body.text.find("]")
    player_input = body.text[close + 1:].strip() if close >= 0 else body.text.strip()
    session.sync_rewind_player_edit(index, player_input)
    session.rebuild_structured_from_scene()
    session._save_meta()
    return {"ok": True, "state": session.snapshot_state()}


@app.delete("/api/session/history/{index}")
def delete_history(index: int):
    session = get_session()
    if index < 0 or index >= len(session.scene_history):
        raise HTTPException(status_code=404, detail="历史条目不存在")
    session.scene_history.pop(index)
    session.rebuild_structured_from_scene()
    session._save_meta()
    return {"ok": True, "state": session.snapshot_state()}


class BranchBody(BaseModel):
    index: int


@app.post("/api/session/history/branch")
def branch_history(body: BranchBody):
    session = get_session()
    idx = body.index
    if idx < 0 or idx >= len(session.scene_history):
        raise HTTPException(status_code=404, detail="历史条目不存在")
    # 优先用最近的存档点回溯全部数据（世界/角色/记忆），否则仅裁剪历史。
    best = None
    for s in session.list_snapshots():
        si = int(s.get("scene_index", 0))
        if si <= idx + 1:
            if best is None or si > int(best.get("scene_index", 0)):
                best = s
    restored = False
    if best:
        path = session.get_snapshot_path(best["id"])
        if path:
            with open(path, encoding="utf-8") as f:
                snap = json.load(f)
            restored = session.restore_snapshot_into_current(snap)
    session.scene_history = session.scene_history[: idx + 1]
    session.rounds_since_forget = 0
    session.rebuild_structured_from_scene()
    session._save_meta()
    return {"ok": True, "restored": restored, "state": session.snapshot_state()}


class StoryEditBody(BaseModel):
    text: str
    directive: str = ""


@app.put("/api/session/story/{scene_index}")
def edit_story(scene_index: int, body: StoryEditBody):
    session = get_session()
    result = session.edit_story_turn(scene_index, body.text, body.directive)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error", "编辑失败"))
    return {"ok": True, "state": result["state"]}


# ---------- 存档点 ----------
class SnapshotBody(BaseModel):
    label: str = ""


@app.get("/api/session/snapshots")
def list_snapshots():
    return {"snapshots": get_session().list_snapshots()}


@app.post("/api/session/snapshots")
def create_snapshot(body: SnapshotBody):
    s = get_session().save_snapshot(label=body.label.strip(), auto=False)
    return {"ok": True, "snapshot": s}


class HistorySnapshotBody(BaseModel):
    index: int
    label: str = ""


@app.post("/api/session/snapshots/from-history")
def create_snapshot_from_history(body: HistorySnapshotBody):
    session = get_session()
    if body.index < 0 or body.index >= len(session.scene_history):
        raise HTTPException(status_code=404, detail="历史条目不存在")
    s = session.save_snapshot(label=body.label.strip() or f"从第 {body.index + 1} 条保存的存档", auto=False, scene_cut=body.index)
    return {"ok": True, "snapshot": s}


@app.delete("/api/session/snapshots/{snap_id}")
def delete_snapshot(snap_id: str):
    ok = get_session().delete_snapshot(snap_id)
    if not ok:
        raise HTTPException(status_code=404, detail="存档点不存在")
    return {"ok": True, "snapshots": get_session().list_snapshots()}


@app.post("/api/session/snapshots/{snap_id}/load")
def load_snapshot(snap_id: str):
    mgr = get_manager()
    entry = mgr.load_snapshot(snap_id)
    if not entry:
        raise HTTPException(status_code=404, detail="存档点不存在")
    return {"ok": True, "session": entry, "state": get_session().snapshot_state()}


@app.get("/api/session/snapshots/{snap_id}/export")
def export_snapshot(snap_id: str):
    session = get_session()
    path = session.get_snapshot_path(snap_id)
    if not path:
        raise HTTPException(status_code=404, detail="存档点不存在")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class SnapshotImportBody(BaseModel):
    snapshot: dict


@app.post("/api/session/snapshots/import")
def import_snapshot(body: SnapshotImportBody):
    mgr = get_manager()
    entry = mgr.create_from_snapshot(body.snapshot)
    return {"ok": True, "session": entry, "state": get_session().snapshot_state()}


# ---------- 世界指令 ----------
class DirectiveBody(BaseModel):
    text: str
    start: str = ""
    end: str = ""


@app.get("/api/session/directives")
def list_directives():
    return {"directives": get_session().world_directives}


@app.post("/api/session/directives")
def add_directive(body: DirectiveBody):
    session = get_session()
    item = {"text": body.text.strip(), "start": body.start.strip(), "end": body.end.strip()}
    if not item["text"]:
        raise HTTPException(status_code=400, detail="指令内容不能为空")
    session.world_directives.append(item)
    session._save_meta()
    return {"ok": True, "directives": session.world_directives}


@app.put("/api/session/directives/{index}")
def edit_directive(index: int, body: DirectiveBody):
    session = get_session()
    if index < 0 or index >= len(session.world_directives):
        raise HTTPException(status_code=404, detail="指令不存在")
    item = {"text": body.text.strip(), "start": body.start.strip(), "end": body.end.strip()}
    if not item["text"]:
        raise HTTPException(status_code=400, detail="指令内容不能为空")
    session.world_directives[index] = item
    session._save_meta()
    return {"ok": True, "directives": session.world_directives}


@app.delete("/api/session/directives/{index}")
def delete_directive(index: int):
    session = get_session()
    if index < 0 or index >= len(session.world_directives):
        raise HTTPException(status_code=404, detail="指令不存在")
    session.world_directives.pop(index)
    session._save_meta()
    return {"ok": True, "directives": session.world_directives}


# ---------- 会话内世界书（分开查看/编辑）----------
@app.get("/api/session/worldbooks")
def session_worldbooks():
    sid = get_manager().active_id()
    if not sid:
        raise HTTPException(status_code=409, detail="尚无当前会话")
    return {"worldbooks": get_manager().session_worldbooks(sid)}


@app.get("/api/session/worldbooks/{wid}")
def session_worldbook_get(wid: str):
    sid = get_manager().active_id()
    data = get_manager().get_session_worldbook(sid, wid)
    if data is None:
        raise HTTPException(status_code=404, detail="世界书不存在")
    return {"worldbook": data}


@app.put("/api/session/worldbooks/{wid}")
def session_worldbook_put(wid: str, body: dict):
    sid = get_manager().active_id()
    data = get_manager().put_session_worldbook(sid, wid, body.get("worldbook", body))
    return {"ok": True, "worldbook": data}


@app.get("/api/session/identity")
def session_identity_get():
    return {"identity": get_session().characters.user_identity}


@app.put("/api/session/identity")
def session_identity_put(body: dict):
    sid = get_manager().active_id()
    session = get_session()
    identity = body.get("identity", body)
    session.characters.user_identity = identity
    _write_json(os.path.join(get_manager().sessions_dir_of(sid), "identity.json"), identity)
    return {"ok": True, "identity": identity}


# ---------- 玩家身份卡（资源库）----------
@app.get("/api/identities")
def list_identities():
    return {"identities": identities.list_identities()}


@app.get("/api/identities/{cid}")
def get_identity(cid: str):
    card = identities.get(cid)
    if card is None:
        raise HTTPException(status_code=404, detail="身份不存在")
    return {"identity": card}


class IdentityBody(BaseModel):
    id: str | None = None
    name: str
    role: str = ""
    description: str = ""


@app.post("/api/identities")
def upsert_identity(body: IdentityBody):
    card = identities.upsert(body.model_dump(exclude_none=True))
    return {"ok": True, "identity": card}


@app.delete("/api/identities/{cid}")
def delete_identity(cid: str):
    identities.delete(cid)
    return {"ok": True}


# ---------- 设置 / API Key ----------
@app.get("/api/settings")
def get_settings():
    """API Key 状态。`api_key_source` 说明 Key 从哪来（env / .env / config.toml），
    便于排查「明明写了 Key 却提示未配置」这类问题。"""
    key = find_api_key()
    return {
        "api_key_set": bool(key),
        "api_key_source": api_key_source(),
        "env_file": ENV_PATH,
        "env_file_exists": os.path.exists(ENV_PATH),
        "mock": mock_enabled(),
    }


class ApiKeyBody(BaseModel):
    key: str


@app.post("/api/settings/apikey")
def set_apikey(body: ApiKeyBody):
    from settings import CONFIG
    key = body.key.strip()
    envpath = os.path.join(CONFIG["BASE_DIR"], ".env")
    with open(envpath, "w", encoding="utf-8") as f:
        f.write(f"DEEPSEEK_API_KEY={key}\n")
    # 直接更新运行期配置并重建会话，让新 Key 立即生效（无需重启）。
    CONFIG["DEEPSEEK_API_KEY"] = key
    get_manager().invalidate()
    return {"ok": True}


# ---------- 运行环境（可选依赖 / 嵌入模型） ----------
# 必需依赖只有 requirements.txt；torch + sentence-transformers 与嵌入模型是
# 可选组件（体积大），未安装时记忆检索自动退回 BM25 关键词匹配。
import env_manager  # noqa: E402


@app.get("/api/env/status")
def env_status(refresh: bool = False):
    """解释器版本、可选依赖、嵌入模型缓存与当前安装/下载任务的状态。"""
    return env_manager.status(refresh=refresh)


class EnvInstallBody(BaseModel):
    index_url: str = ""


@app.post("/api/env/install-embedding")
def env_install_embedding(body: EnvInstallBody | None = None):
    """后台 pip 安装 torch + sentence-transformers（进度用 /api/env/task 轮询）。"""
    try:
        task_id = env_manager.start_install_embedding(
            index_url=(body.index_url if body else ""))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "task_id": task_id, "task": env_manager.current_task()}


class EnvDownloadBody(BaseModel):
    model: str = ""
    mirror: str = ""


@app.post("/api/env/download-model")
def env_download_model(body: EnvDownloadBody | None = None):
    """后台下载嵌入模型到 HuggingFace 缓存（默认关闭离线开关后联网拉取）。"""
    try:
        task_id = env_manager.start_download_model(
            model_name=(body.model if body else ""),
            mirror=(body.mirror if body else ""),
        )
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "task_id": task_id, "task": env_manager.current_task()}


@app.get("/api/env/task")
def env_task():
    return env_manager.current_task()


@app.post("/api/env/cancel")
def env_cancel():
    return env_manager.cancel_task()


# ---------- 系统信息 / 手机远程关机 ----------
def _lan_ip() -> str:
    """取本机局域网 IPv4（用于手机同 Wi-Fi 访问）；失败时回退到 127.0.0.1。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip or "127.0.0.1"
    except Exception:  # noqa: BLE001
        return "127.0.0.1"


@app.get("/api/system/info")
def system_info():
    """供前端显示本机局域网 IP，方便手机直接访问，无需 ipconfig。"""
    return {"ip": _lan_ip(), "os": "windows" if os.name == "nt" else "other"}


class ShutdownBody(BaseModel):
    confirm: bool = False


@app.post("/api/system/shutdown")
def system_shutdown(body: ShutdownBody):
    """请求关闭当前电脑（30 秒倒计时，可取消）。仅 Windows 支持；需 confirm=True。"""
    if not body.confirm:
        raise HTTPException(status_code=400, detail="需要明确确认关机")
    if mock_enabled():
        raise HTTPException(status_code=400, detail="mock 模式下不执行真实关机")
    if os.name != "nt":
        raise HTTPException(status_code=400, detail="仅支持 Windows 关机")
    # 防呆：使用系统自带的 shutdown /s，倒计时 30 秒，期间可用 shutdown /a 取消。
    subprocess.Popen(
        ["shutdown", "/s", "/t", "30", "/c", "AI老婆·世界 将在30秒后关机"],
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return {"ok": True, "seconds": 30}


@app.post("/api/system/shutdown/cancel")
def system_shutdown_cancel():
    """取消正在倒计时的关机。"""
    if os.name != "nt":
        raise HTTPException(status_code=400, detail="仅支持 Windows")
    subprocess.Popen(["shutdown", "/a"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True, "note": "已尝试取消关机"}


# ---------- 日志 ----------
@app.get("/api/logs")
def list_logs():
    # 查看日志前先清理过期文件（保留时长见 config.toml 的 [logs].retention_days）。
    try:
        from llm_logger import cleanup_old_logs
        cleanup_old_logs()
    except Exception:  # noqa: BLE001
        pass
    from llm_logger import _log_dir
    root = _log_dir()
    mgr = get_manager()

    def _log_file(name: str, path: str) -> dict:
        stem = name[:-6] if name.endswith(".jsonl") else name
        kind, _, date = stem.partition("_")
        return {"name": name, "size": os.path.getsize(path), "date": date, "kind": kind}

    sessions = []
    if os.path.isdir(root):
        # 顶层无会话文件（兜底，正常情况下不应出现）
        flat = []
        for name in sorted(os.listdir(root)):
            p = os.path.join(root, name)
            if os.path.isfile(p) and name.endswith(".jsonl"):
                flat.append(_log_file(name, p))
        if flat:
            sessions.append({"id": "default", "name": "（默认 / 无会话）", "files": flat})

        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if not os.path.isdir(d):
                continue
            files = []
            for fn in sorted(os.listdir(d)):
                if fn.endswith(".jsonl"):
                    files.append(_log_file(fn, os.path.join(d, fn)))
            meta = mgr.get_session(name)
            sname = (meta.get("name") if meta else None) or name
            sessions.append({"id": name, "name": sname, "files": files})
    return {"sessions": sessions}


@app.get("/api/logs/content")
def log_content(session: str = "default", name: str = ""):
    import json as _json
    from llm_logger import _log_dir
    safe = os.path.basename(name)
    if not safe:
        raise HTTPException(status_code=400, detail="缺少日志文件名")
    if session == "default":
        p = os.path.join(_log_dir(), safe)
    else:
        p = os.path.join(_log_dir(), os.path.basename(session), safe)
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail="日志不存在")
    rows = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                try:
                    rows.append(_json.loads(line))
                except _json.JSONDecodeError:
                    rows.append({"raw": line})
    return {"content": rows}


# ---------- 世界书 ----------
@app.get("/api/worldbook")
def get_worldbook():
    data = _read_json(CONFIG["WORLDBOOK_PATH"], {})
    return {"worldbook": data}


class WorldSummaryBody(BaseModel):
    overview: str | None = None
    background: str | None = None
    tone: str | None = None


@app.put("/api/session/world-summary")
def put_world_summary(body: WorldSummaryBody):
    """编辑当前会话的世界摘要/背景/基调，立即生效并刷新状态。"""
    session = get_session()
    if body.overview is not None:
        session.world.background["overview"] = body.overview.strip()
    if body.background is not None:
        session.world.background["background"] = body.background.strip()
    if body.tone is not None:
        session.world.background["tone"] = body.tone.strip()
    session.world.save_background()
    session._save_meta()
    return {"ok": True, "state": session.snapshot_state()}


@app.put("/api/worldbook")
def put_worldbook(body: dict):
    wb = body.get("worldbook", body)
    _write_json(CONFIG["WORLDBOOK_PATH"], wb)
    return {"ok": True, "note": "世界书已更新，新建/初始化会话时生效"}


# ---------- 资源库：世界书 ----------
@app.get("/api/library/worldbooks")
def library_worldbooks():
    return {"worldbooks": worldbook_library.list_worldbooks()}


@app.get("/api/library/worldbooks/{wid}")
def library_worldbook_get(wid: str):
    data = worldbook_library.get(wid)
    if data is None:
        raise HTTPException(status_code=404, detail="世界书不存在")
    return {"worldbook": data}


@app.put("/api/library/worldbooks/{wid}")
def library_worldbook_put(wid: str, body: dict):
    data = worldbook_library.upsert(wid, body.get("worldbook", body))
    return {"ok": True, "worldbook": data}


@app.delete("/api/library/worldbooks/{wid}")
def library_worldbook_delete(wid: str):
    worldbook_library.delete(wid)
    return {"ok": True}


# ---------- 资源库：角色 ----------
@app.get("/api/library/characters")
def library_characters(q: str = "", tag: str = ""):
    tags = [t for t in tag.split(",") if t]
    return {"characters": character_library.list_characters(q, tags)}


@app.get("/api/library/characters/tags")
def library_character_tags():
    return {"tags": character_library.all_tags()}


@app.get("/api/library/characters/{cid}")
def library_character_get(cid: str):
    card = character_library.get(cid)
    if card is None:
        raise HTTPException(status_code=404, detail="角色不存在")
    return {"card": card_schema.normalize_card_avatar(card)}


@app.put("/api/library/characters/{cid}")
def library_character_put(cid: str, body: dict):
    card = character_library.upsert({**body.get("card", body), "id": cid})
    return {"ok": True, "card": card}


@app.delete("/api/library/characters/{cid}")
def library_character_delete(cid: str):
    character_library.delete(cid)
    return {"ok": True}


# ---------- 角色 ----------
@app.get("/api/characters")
def list_characters():
    session = get_session()
    out = []
    for cid in session.characters.all_ids():
        rec = session.characters.get(cid)
        state = rec["state"]
        card = rec["card"]
        out.append({
            "id": cid,
            "name": session.characters.display_name(cid),
            "surname": card.get("surname", ""),
            "is_core": rec["is_core"],
            "intro": card.get("intro", "") or card.get("identity", ""),
            "location": state.get("location", ""),
            "mood": state.get("mood", ""),
            "doing": state.get("doing", ""),
            "avatar": card_schema.normalize_avatar(card.get("avatar", "")),
        })
    return {"characters": out}


@app.get("/api/characters/graph")
def character_graph():
    """返回当前会话全部角色的关系网，供前端绘制有向图。"""
    session = get_session()
    nodes = []
    edges = []
    node_names = set()
    session_node = {}

    # 先放全部会话角色节点（含头像）
    for cid in session.characters.all_ids():
        rec = session.characters.get(cid)
        name = session.characters.display_name(cid)
        node = {
            "id": cid,
            "name": name,
            "is_core": rec["is_core"],
            "avatar": card_schema.normalize_avatar(rec["card"].get("avatar", "")),
        }
        nodes.append(node)
        node_names.add(name)
        session_node[name] = node

    def resolve_target(target: str) -> tuple[str, dict]:
        """把关系目标解析成一个节点；返回 (节点名, 节点)。"""
        # 1) 会话内角色：支持 id / 名 / 全名 / 别名
        cid = session.characters.resolve(target)
        if cid:
            name = session.characters.display_name(cid)
            return name, session_node.get(name)
        # 2) 资源库角色：取“名”并补头像
        lib_cid = character_library.resolve(target)
        if lib_cid:
            card = character_library.get(lib_cid) or {}
            name = card_schema.display_name(card) or target
            node = {
                "id": lib_cid,
                "name": name,
                "is_core": card_schema.is_core(card),
                "avatar": card_schema.normalize_avatar(card.get("avatar", "")),
            }
            return name, node
        # 3) 完全未知：原样作为外部节点，无头像
        return target, {"id": target, "name": target, "is_core": False, "avatar": ""}

    # 边
    for cid in session.characters.all_ids():
        from_name = session.characters.display_name(cid)
        for rel in session.characters.relationships(cid):
            target = rel.get("target", "")
            if not target:
                continue
            to_name, node = resolve_target(target)
            if node and node["name"] not in node_names:
                nodes.append(node)
                node_names.add(node["name"])
            edges.append({
                "from": from_name,
                "to": to_name,
                "address": rel.get("address", ""),
                "relation": rel.get("relation", ""),
                "detail": rel.get("detail", ""),
                "affection": rel.get("affection"),
                "directed": bool(rel.get("directed", False)),
            })
    return {"nodes": nodes, "edges": edges}


@app.get("/api/characters/{cid}")
def get_character(cid: str):
    session = get_session()
    rec = session.characters.get(cid)
    if not rec:
        raise HTTPException(status_code=404, detail="角色不存在")
    return {"id": cid,
            "card": card_schema.normalize_card_avatar(rec["card"]),
            "state": rec["state"],
            "is_core": rec["is_core"]}


class CharacterUpdate(BaseModel):
    card: dict | None = None
    state: dict | None = None


@app.put("/api/characters/{cid}")
def update_character(cid: str, body: CharacterUpdate):
    session = get_session()
    if not session.characters.get(cid):
        raise HTTPException(status_code=404, detail="角色不存在")
    if body.card is not None:
        session.characters.update_card(cid, body.card)
    if body.state is not None:
        session.characters.update_state(cid, body.state)
    session.characters.save()
    rec = session.characters.get(cid)
    return {"id": cid, "card": rec["card"], "state": rec["state"]}


@app.post("/api/characters/{cid}/promote")
def promote_character(cid: str):
    session = get_session()
    ok = session.characters.promote_to_core(cid)
    if not ok:
        raise HTTPException(status_code=400, detail="已是核心角色或不存在")
    session.characters.save()
    return {"ok": True, "id": cid, "is_core": True}


class CharacterAdd(BaseModel):
    id: str = ""


@app.post("/api/characters")
def add_session_character(body: CharacterAdd):
    session = get_session()
    cid = (body.id or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="缺少角色 id")
    card = character_library.get(cid)
    if not card:
        raise HTTPException(status_code=404, detail="资源库中不存在该角色")
    added = session.characters.add_from_library(card)
    session.characters.save()
    # 同步会话索引中的角色列表，保证列表计数正确。
    mgr = get_manager()
    sid = mgr.active_id()
    meta = mgr.get_session(sid) if sid else None
    if meta is not None:
        chars = list(meta.get("characters") or [])
        if added not in chars:
            meta["characters"] = chars + [added]
            mgr.save_index()
    return {"ok": True, "id": added, "state": session.snapshot_state()}


@app.delete("/api/characters/{cid}")
def remove_session_character(cid: str):
    session = get_session()
    ok = session.characters.remove(cid)
    if not ok:
        raise HTTPException(status_code=404, detail="角色不存在")
    session.characters.save()
    session.memory_cache.pop(cid, None)
    if session.session_dir:
        memdir = os.path.join(session.session_dir, "memory")
        for suffix in (".json", ".bm25.pkl", ".vec.pkl"):
            p = os.path.join(memdir, f"{cid}{suffix}")
            if os.path.exists(p):
                os.remove(p)
    mgr = get_manager()
    sid = mgr.active_id()
    meta = mgr.get_session(sid) if sid else None
    if meta is not None:
        meta["characters"] = [c for c in (meta.get("characters") or []) if c != cid]
        mgr.save_index()
    return {"ok": True, "state": session.snapshot_state()}


# ---------- 记忆 ----------
@app.get("/api/characters/{cid}/memory")
def get_memory(cid: str):
    session = get_session()
    if not session.characters.get(cid):
        raise HTTPException(status_code=404, detail="角色不存在")
    memory = session.get_memory(cid)
    return {
        "character_id": cid,
        "max_events": CONFIG["MAX_MEMORY_EVENTS"],
        "stats": memory.stats(),
        "working_memory": memory.working_memory,
        "events": list(memory.events.values()),
    }


@app.delete("/api/characters/{cid}/memory/events/{eid}")
def delete_memory_event(cid: str, eid: str):
    session = get_session()
    memory = session.get_memory(cid)
    ok = memory.delete_event(eid)
    if not ok:
        raise HTTPException(status_code=404, detail="事件不存在")
    return {"ok": True, "stats": memory.stats()}


class MemoryAdd(BaseModel):
    summary: str
    text: str = ""
    importance: float = 0.5


@app.post("/api/characters/{cid}/memory/events")
def add_memory_event(cid: str, body: MemoryAdd):
    session = get_session()
    if not session.characters.get(cid):
        raise HTTPException(status_code=404, detail="角色不存在")
    memory = session.get_memory(cid)
    try:
        eid = memory.add_manual_event(body.summary, body.text, body.importance)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "event_id": eid, "stats": memory.stats()}


# ---------- 提示词与配置 ----------
@app.get("/api/prompts")
def get_prompts():
    return {"prompts": load_prompts()}


class PromptsUpdate(BaseModel):
    prompts: dict[str, str]


@app.put("/api/prompts")
def update_prompts(body: PromptsUpdate):
    for key, text in body.prompts.items():
        if isinstance(text, str):
            set_prompt(key, text)
    return {"prompts": load_prompts()}


@app.get("/api/config")
def get_config():
    raw = _cfg_raw()
    if "llm" in raw and "api_key" in raw["llm"]:
        raw["llm"].pop("api_key")
    return {"config": raw}


@app.get("/api/session/config")
def session_config_get():
    """当前会话的配置覆盖（仅影响本会话；为空表示沿用全局设置）。"""
    return {"config": get_session()._load_session_override()}


class SessionConfigBody(BaseModel):
    config: dict


@app.put("/api/session/config")
def session_config_put(body: SessionConfigBody):
    """保存当前会话的配置覆盖，仅作用于本会话；全局 config.toml 不受影响。"""
    session = get_session()
    return session.save_session_config(body.config)


@app.put("/api/config")
def update_config(body: dict):
    raw = _cfg_raw()
    provided = body.get("config", body)
    if "llm" in provided and isinstance(provided["llm"], dict):
        provided["llm"].pop("api_key", None)

    def merge(dst, src):
        for k, v in src.items():
            if isinstance(v, dict) and isinstance(dst.get(k), dict):
                merge(dst[k], v)
            else:
                dst[k] = v

    merge(raw, provided)
    try:
        _cfg_write(raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"配置写入失败：{e}")
    # 嵌入开关/模型名/镜像改动后释放共享模型，下次检索按新配置重新加载。
    if isinstance(provided.get("embedding"), dict) or isinstance(provided.get("env"), dict):
        try:
            from embedding import forget_shared_embedder
            forget_shared_embedder()
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "note": "大部分更改立即生效；监听地址/端口等需重启服务"}


_DIST = os.path.normpath(os.path.join(CONFIG["BASE_DIR"], "..", "web", "dist"))
if os.path.isdir(_DIST):
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_DIST, html=True), name="web")


def main():
    parser = argparse.ArgumentParser(description="TRPE 后端服务")
    parser.add_argument("--mock", action="store_true", help="离线模式，不调用真实 LLM")
    parser.add_argument("--host", default=CONFIG["SERVER_HOST"])
    parser.add_argument("--port", type=int, default=CONFIG["SERVER_PORT"])
    args = parser.parse_args()
    if args.mock:
        os.environ["MOCK"] = "1"
    # 启动时清理日志：默认只保留最近 N 天（config.toml 的 [logs].retention_days）。
    try:
        from llm_logger import cleanup_old_logs
        cleanup_old_logs()
    except Exception:  # noqa: BLE001  清理失败不阻塞启动
        pass
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
