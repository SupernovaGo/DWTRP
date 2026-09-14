"""
会话管理器
================
资源库（世界书/角色/身份卡模板）是全局的；每个会话在创建时**复制**选中的模板，

首次进入**没有默认会话**（空白），前端引导用户新建或选择一个旧会话。

每个会话独立目录 data/sessions/<id>/：
  worldbooks/<wid>.json    选中的世界书副本（各自独立，不合并）
  worldbook.json           合并后的世界书（仅供引擎摘要使用）
  characters/<cid>.json    选中的角色副本
  identity.json            选中的玩家身份副本
  state/                   运行时状态
"""
import copy
import json
import os
import shutil
import time

import card_schema
from i18n import tr
from settings import CONFIG, ensure_dirs
from library_seed import ensure_initialized
from world_session import WorldSession
import character_library
import worldbook_library
import player_identities as identities


def _load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def _save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


class SessionManager:
    def __init__(self, mock: bool = False):
        self.mock = mock
        ensure_dirs()
        ensure_initialized()
        self.sessions_root = os.path.join(CONFIG["DATA_DIR"], "sessions")
        self.index_path = os.path.join(self.sessions_root, "index.json")
        os.makedirs(self.sessions_root, exist_ok=True)
        self.data = _load_json(self.index_path, None)
        if not self.data:
            self.data = {"sessions": [], "active_id": None}
            self.save_index()
        self._active_world = None
        self._active_sid = None
        self._ensure_default_session()

    def _ensure_default_session(self):
        """首次启动（资源库已有世界书且无任何会话）时，自动创建一个可立即开聊的默认会话。
        不调用 LLM 初始化，直接采用世界书首地点 + 默认开始时间，避免启动阻塞。
        """
        if not CONFIG.get("AUTO_CREATE_DEFAULT_SESSION", True):
            return
        if self.data.get("sessions"):
            return
        wbs = worldbook_library.list_worldbooks()
        if not wbs:
            return
        n_wb = max(1, int(CONFIG.get("DEFAULT_STARTER_WORLDBOOKS", 1) or 1))
        wb_ids = [w["id"] for w in wbs[:n_wb]]

        n_char = max(0, int(CONFIG.get("DEFAULT_STARTER_CHARACTERS", 8) or 8))
        core = [c for c in character_library.list_characters() if c.get("is_core")]
        core.sort(key=lambda c: c.get("id", ""))
        char_ids = [c["id"] for c in core[:n_char]]

        sid = os.urandom(4).hex()
        self._copy_worldbooks(sid, wb_ids)
        self._copy_characters(sid, char_ids)
        self._copy_identity(sid, "")
        entry = {
            "id": sid,
            "name": tr("开始对话"),
            "hint": "老师来到了基沃托斯，开始了今天的日常。",
            "worldbooks": wb_ids,
            "characters": char_ids,
            "identity_id": "",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "status": "active",
        }
        self.data["sessions"].append(entry)
        self.data["active_id"] = sid
        self.save_index()
        self.invalidate()
        init = self._default_init(wb_ids[0])
        try:
            self.get_world_session(sid).apply_init(init)
        except Exception:  # noqa: BLE001  初始化失败不阻塞启动
            pass
        return entry

    def _default_init(self, wid: str) -> dict:
        data = worldbook_library.get(wid) or {}
        locs = card_schema.world_locations(data)
        # 玩家是“老师/顾问”，优先落在其驻地（沙勒/夏莱、联邦学生会），否则取第一个地点
        def pick(names):
            for loc in locs:
                if any(k in loc["name"] for k in names):
                    return loc["name"]
            return ""
        location = (pick(["沙勒", "夏莱"])
                    or pick(["联邦学生会", "D.U."])
                    or (locs[0]["name"] if locs else ""))
        return {
            "time": CONFIG["START_TIME"],
            "location": location,
            "weather": "晴朗",
            "scene_summary": f"老师来到了{location or '基沃托斯'}，开始了在基沃托斯的一天。",
            "details": [],
            "character_plans": {},
        }

    # ---------- 索引 ----------
    def save_index(self):
        _save_json(self.index_path, self.data)

    def active_id(self):
        return self.data.get("active_id")

    def rename(self, sid: str, name: str) -> dict | None:
        name = (name or "").strip()
        if not name:
            return None
        entry = self.get_session(sid)
        if not entry:
            return None
        entry["name"] = name
        self.save_index()
        self.invalidate()
        return dict(entry)

    def list_sessions(self) -> list:
        active = self.active_id()
        out = []
        for s in self.data["sessions"]:
            item = dict(s)
            item["is_active"] = s["id"] == active
            sdir = self.sessions_dir_of(s["id"])
            item["characters"] = len(os.listdir(os.path.join(sdir, "characters"))) \
                if os.path.isdir(os.path.join(sdir, "characters")) else 0
            item["worldbooks"] = s.get("worldbooks") or []
            out.append(item)
        return out

    def sessions_dir_of(self, sid: str) -> str:
        return os.path.join(self.sessions_root, sid)

    def get_world_session(self, sid: str = None) -> WorldSession:
        sid = sid or self.active_id()
        if not sid or not self.get_session(sid):
            raise ValueError(tr("尚无当前会话，请先新建或选择会话"))
        if self._active_world is None or self._active_sid != sid:
            self._active_world = WorldSession(
                mock=self.mock, session_dir=self.sessions_dir_of(sid))
            self._active_sid = sid
        return self._active_world

    def invalidate(self):
        self._active_world = None
        self._active_sid = None

    # ---------- 复制资源 ----------
    def _copy_worldbooks(self, sid: str, ids: list):
        sdir = os.path.join(self.sessions_root, sid)
        wbdir = os.path.join(sdir, "worldbooks")
        os.makedirs(wbdir, exist_ok=True)
        selected = []
        for wid in ids or []:
            wb = worldbook_library.get(wid)
            if not wb:
                continue
            selected.append(wb)
            _save_json(os.path.join(wbdir, f"{wid}.json"), wb)
        merged = worldbook_library.merge_worldbooks(selected)
        if not merged:
            merged = {"world": tr("未配置世界书"), "overview": tr("（尚未选择世界书）")}
        # 仅用作引擎摘要；查看/编辑仍是各世界书独立副本
        _save_json(os.path.join(sdir, "worldbook.json"), merged)

    def _copy_characters(self, sid: str, ids: list):
        sdir = os.path.join(self.sessions_root, sid)
        cdir = os.path.join(sdir, "characters")
        os.makedirs(cdir, exist_ok=True)
        for cid in ids or []:
            card = character_library.get(cid)
            if not card:
                continue
            card = copy.deepcopy(card)
            _save_json(os.path.join(cdir, f"{cid}.json"), card)

    def _copy_identity(self, sid: str, identity_id: str):
        sdir = os.path.join(self.sessions_root, sid)
        card = identities.get(identity_id)
        if card:
            _save_json(os.path.join(sdir, "identity.json"), card)

    # ---------- 会话操作 ----------
    def create(self, name: str, worldbook_ids: list, character_ids: list,
               identity_id: str, hint: str = "", sid: str = None) -> dict:
        sid = sid or os.urandom(4).hex()
        self._copy_worldbooks(sid, worldbook_ids)
        self._copy_characters(sid, character_ids)
        self._copy_identity(sid, identity_id)
        entry = {
            "id": sid,
            "name": name or sid,
            "hint": hint or "",
            "worldbooks": worldbook_ids or [],
            "characters": character_ids or [],
            "identity_id": identity_id or "",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "status": "created",
        }
        self.data["sessions"].append(entry)
        self.data["active_id"] = sid
        self.save_index()
        self.invalidate()
        return entry

    def get_session(self, sid: str) -> dict | None:
        for s in self.data["sessions"]:
            if s["id"] == sid:
                return s
        return None

    def set_active(self, sid: str):
        self.data["active_id"] = sid
        self.save_index()
        self.invalidate()

    def initialize(self, sid: str, hint: str) -> dict:
        session = self.get_world_session(sid)
        preview = session.initialize_from_hint(hint)
        meta = self.get_session(sid)
        if meta:
            meta["hint"] = hint
            meta["status"] = "init_preview"
            self.save_index()
        return {"session": meta, "preview": preview}

    def start(self, sid: str, init: dict) -> dict:
        session = self.get_world_session(sid)
        session.apply_init(init)
        meta = self.get_session(sid)
        if meta:
            meta["status"] = "active"
            self.save_index()
        self.data["active_id"] = sid
        self.save_index()
        return {"ok": True, "state": session.snapshot_state()}

    def delete(self, sid: str) -> bool:
        self.data["sessions"] = [s for s in self.data["sessions"]
                                 if s["id"] != sid]
        if self.active_id() == sid:
            self.data["active_id"] = self.data["sessions"][0]["id"] \
                if self.data["sessions"] else None
        self.save_index()
        rdir = self.sessions_dir_of(sid)
        if rdir and os.path.isdir(rdir):
            shutil.rmtree(rdir)
        self.invalidate()
        return True

    # ---------- 会话内世界书（分开查看/编辑）----------
    def session_worldbooks(self, sid: str) -> list:
        wbdir = os.path.join(self.sessions_dir_of(sid), "worldbooks")
        if not os.path.isdir(wbdir):
            return []
        out = []
        for name in sorted(os.listdir(wbdir)):
            if not name.lower().endswith(".json"):
                continue
            wid = name[:-5]
            data = _load_json(os.path.join(wbdir, name), {})
            out.append({
                "id": wid,
                "name": card_schema.wb_name(data) or wid,
                "world": data.get("world") or "",
            })
        return out

    def get_session_worldbook(self, sid: str, wid: str) -> dict | None:
        return _load_json(
            os.path.join(self.sessions_dir_of(sid), "worldbooks", f"{wid}.json"), None)

    def put_session_worldbook(self, sid: str, wid: str, data: dict) -> dict:
        _save_json(os.path.join(self.sessions_dir_of(sid), "worldbooks", f"{wid}.json"), data)
        return data

    # ---------- 存档点：载入到新会话 ----------
    def load_snapshot(self, snap_id: str) -> dict | None:
        ws = self.get_world_session()
        path = ws.get_snapshot_path(snap_id)
        if not path:
            return None
        with open(path, encoding="utf-8") as f:
            snap = json.load(f)
        return self.create_from_snapshot(snap)

    def create_from_snapshot(self, snap: dict) -> dict:
        """根据存档点创建一个完全独立的新会话（不依赖原会话或资源库）。"""
        sid = os.urandom(4).hex()
        sdir = self.sessions_dir_of(sid)
        os.makedirs(os.path.join(sdir, "characters"), exist_ok=True)
        os.makedirs(os.path.join(sdir, "character_states"), exist_ok=True)
        os.makedirs(os.path.join(sdir, "memory"), exist_ok=True)
        _save_json(os.path.join(sdir, "world_state.json"), snap.get("world") or {})
        _save_json(os.path.join(sdir, "timeline.json"), {"events": snap.get("timeline") or []})
        _save_json(os.path.join(sdir, "player_perception.json"), snap.get("perception") or {})
        _save_json(os.path.join(sdir, "identity.json"), snap.get("user_identity") or {})

        char_ids = []
        for ch in snap.get("characters") or []:
            cid = ch.get("id") or ""
            if not cid:
                continue
            char_ids.append(cid)
            card = copy.deepcopy(ch.get("card") or {})
            card["id"] = cid
            _save_json(os.path.join(sdir, "characters", f"{cid}.json"), card)
            _save_json(os.path.join(sdir, "character_states", f"{cid}.json"), ch.get("state") or {})

        memdir = os.path.join(sdir, "memory")
        # 向量统一存 Milvus；事件 JSON 由 CharacterMemory
        # 在首次检索时自动补齐嵌入向量。这里的 mem 来自快照（含 event_vecs/chunk_vecs
        # 等旧字段），只把事件/近期记忆字样写回即可。
        for cid, mem in (snap.get("memory") or {}).items():
            payload = {k: v for k, v in mem.items()
                       if k not in ("event_vecs", "chunk_vecs")}
            _save_json(os.path.join(memdir, f"{cid}.json"), payload)

        cut = snap.get("cut_scene_index")
        history = snap.get("scene_history") or []
        if isinstance(cut, int) and cut >= 0:
            history = history[: cut + 1]
        _save_json(os.path.join(sdir, "session.json"), {
            "scene_history": history,
            "structured_history": list(snap.get("structured_history") or []),
            "player_update_hints": [],
            "show_thought": bool(snap.get("show_thought")),
            "world_directives": snap.get("world_directives") or [],
            "rounds_since_forget": 0,
        })
        uident = snap.get("user_identity") or {}
        entry = {
            "id": sid,
            "name": tr("存档·{label}", label=snap.get("label", tr("存档"))),
            "hint": "",
            "worldbooks": [],
            "characters": char_ids,
            "identity_id": uident.get("id", ""),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "status": "active",
        }
        self.data["sessions"].append(entry)
        self.data["active_id"] = sid
        self.save_index()
        self.invalidate()
        return entry
