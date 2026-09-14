"""
世界会话循环
==================
把 Agent 串联成一个可持续、可离线保存的交互循环，并通过结构化事件流
与前端通信（处理中状态、环境变化、角色流式输出、世界/角色更新、记忆总结等）。
  - 每次调用带 request_id，并记录完整 prompt/返回（见 llm_logger）。
  - 角色引用支持“id 或中文名”双向解析，避免模型用名字找不到角色卡。
  - 支持长任务的状态提示（processing）与角色回复的流式 token（character_delta）。
  - 支持按会话指定独立的运行时目录（多会话）。
"""
import json
import os
import time
import uuid
import copy
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from agents.core import (
    _recent_player_history,
    _scene_lines,
    _build_system,
    _world_identity_block,
    CharacterUpdateAgent,
    EnvironmentAgent,
    FrontAgent,
    PlayerAgent,
    WorldUpdateAgent,
)
from characters import CharacterStore
import card_schema
from embedding import Embedder
from i18n import tr
from llm_client import LLMClient
from llm_logger import log_event, set_request_session
from memory import CharacterMemory
from memory_summarizer import summarize_and_store
from prompts_store import get_prompt
from renderers import render_front_turn, render_world_changes
from settings import CONFIG, apply_session_override, ensure_dirs, read_core_only_update

def _normalize_markers(text: str) -> str:
    """折叠重复的标记符（** → *、「「 → 「），修复历史双包裹数据。"""
    t = (text or "")
    t = re.sub(r"\*{2,}", "*", t)
    t = re.sub(r"「{2,}", "「", t)
    t = re.sub(r"」{2,}", "」", t)
    return t


def _is_marker_fragment(text: str) -> bool:
    return (text or "").strip() in ("", "「", "」", "*", "**", "...", "……")


def _parse_marked_segments(text: str) -> list:
    """把带标记的角色文本（*动作*、「说话」）解析回 sequence，保证编辑后仍能分开渲染。"""
    raw = _normalize_markers(text)
    # 第一遍：抽出动作 *...*（动作优先级高于被误包进的说话标记）
    toks = []
    pos = 0
    for m in re.finditer(r"\*+([^*]+)\*+", raw or ""):
        if m.start() > pos:
            toks.append(("plain", raw[pos:m.start()]))
        toks.append(("action", m.group(1)))
        pos = m.end()
    if pos < len(raw or ""):
        toks.append(("plain", raw[pos:]))

    # 第二遍：在普通文本里再抽说话「...」
    segs = []
    for kind, part in toks:
        if kind == "action":
            body = part.strip()
            if body and not _is_marker_fragment(body):
                segs.append({"type": "action", "text": body})
            continue
        p = 0
        for m in re.finditer(r"「+([^」]+)」+", part or ""):
            if m.start() > p:
                plain = part[p:m.start()].strip()
                if plain and not _is_marker_fragment(plain):
                    segs.append({"type": "speech", "text": plain})
            body = m.group(1).strip()
            if body and not _is_marker_fragment(body):
                segs.append({"type": "speech", "text": body})
            p = m.end()
        tail = (part or "")[p:].strip()
        if tail and not _is_marker_fragment(tail):
            segs.append({"type": "speech", "text": tail})
    if not segs and (raw or "").strip():
        segs.append({"type": "speech", "text": raw.strip()})
    return segs
from time_utils import crossed_time, parse_iso as parse_time
from world_state import WorldState


class WorldSession:
    def __init__(self, mock: bool = False, session_dir: str = None):
        if not session_dir:
            raise ValueError("记忆/状态只归属于会话，必须提供 session_dir。")
        session_dir = os.path.abspath(session_dir)
        self.session_dir = session_dir
        self.session_id = os.path.basename(os.path.normpath(session_dir))
        # 会话配置覆盖：全局 config.toml 为底座，叠加该会话的 config.json，并即时生效。
        apply_session_override(self._load_session_override())
        self._set_session_paths()

        ensure_dirs()
        self.mock = mock
        self.session_meta_path = os.path.join(CONFIG["STATE_DIR"], "session.json")
        self.llm = LLMClient(mock=mock)
        self.world = WorldState()
        self.characters = CharacterStore()
        self._embedder = None
        self.memory_cache = {}

        self.player_agent = PlayerAgent(self.world, self.characters, self.llm, self.get_memory)
        self.env_agent = EnvironmentAgent(self.world, self.characters, self.llm)
        self.front_agent = FrontAgent(
            self.world, self.characters, self.llm, self.get_memory)
        self.character_update_agent = CharacterUpdateAgent(
            self.world, self.characters, self.llm, self.get_memory)
        self.world_update_agent = WorldUpdateAgent(
            self.world, self.characters, self.llm)

        meta = self._load_meta()
        self.scene_history = meta.get("scene_history", [])
        self.player_update_hints = meta.get("player_update_hints", [])
        self.world_update_hints = meta.get("world_update_hints", [])
        self.world_directives = meta.get("world_directives", [])
        self.structured_history = meta.get("structured_history", [])
        self.show_thought = meta.get(
            "show_thought", CONFIG["THOUGHT_VISIBLE_BY_DEFAULT"])
        self.rounds_since_forget = meta.get("rounds_since_forget", 0)
        self._turn_counter = int(meta.get("turn_counter", 0))
        self.world_entry_activations = list(meta.get("world_entry_activations", []))
        self.last_character_update_summary = []
        self.turn_events = []
        self._on_event = None
        self._update_lock = threading.RLock()
        self.background_update_active = False
        self.background_update_status = ""
        self.pending_updates = []
        self.request_id = uuid.uuid4().hex[:12]
        self.rewind_stack = self._load_rewinds()
        self._rewinding = False
        self._last_working_ctx = None
        self._scene_members_last = set()
        self._scene_left = set()
        # 延后写入的近期记忆：玩家发下一条时才真正落盘，避免“刚写进去就被重写污染/总结”。
        self._pending_memory_ops = {}
        self.story_mode = bool(meta.get("story_mode", False))
        if (
            (not self.structured_history and self.scene_history)
            or self._has_marker_corruption()
        ):
            self._migrate_structured_history()
        self._migrate_opening_background()
        self._strip_transient_history()
        self._assign_scene_indexes()

    def _set_session_paths(self):
        """把 CONFIG 中与本会话相关的路径指向会话专属目录。"""
        CONFIG["STATE_DIR"] = self.session_dir
        CONFIG["CHARACTER_STATES_DIR"] = os.path.join(self.session_dir, "character_states")
        CONFIG["MEMORY_DIR"] = os.path.join(self.session_dir, "memory")
        CONFIG["WORLD_STATE_PATH"] = os.path.join(self.session_dir, "world_state.json")
        CONFIG["TIMELINE_PATH"] = os.path.join(self.session_dir, "timeline.json")
        CONFIG["PLAYER_PERCEPTION_PATH"] = os.path.join(self.session_dir, "player_perception.json")
        CONFIG["CORE_CHARACTERS_DIR"] = os.path.join(self.session_dir, "characters")
        CONFIG["GENERAL_CHARACTERS_PATH"] = os.path.join(self.session_dir, "general_characters.json")
        CONFIG["WORLDBOOK_PATH"] = os.path.join(self.session_dir, "worldbook.json")
        CONFIG["USER_IDENTITY_PATH"] = os.path.join(self.session_dir, "identity.json")

    def _load_session_override(self) -> dict:
        p = os.path.join(self.session_dir, "config.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        return {}

    def config_path(self) -> str:
        return os.path.join(self.session_dir, "config.json")

    def save_session_config(self, cfg: dict):
        """保存当前会话的配置覆盖（仅作用于本会话），并立即应用到运行时。"""
        p = self.config_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(cfg or {}, f, ensure_ascii=False, indent=2)
        apply_session_override(cfg or {})
        self._set_session_paths()
        self._save_meta()
        return {"ok": True, "config": cfg or {}}

    def _has_marker_corruption(self) -> bool:
        """检测早前“双包裹标记”造成的损坏（** 与 「「），需要重建结构化历史。"""
        return any(
            ("**" in (line or "")) or ("「「" in (line or ""))
            for line in self.scene_history
        )

    def _infer_structured_from_scene(self, prior: list | None = None) -> list:
        """根据 scene_history 推断结构化事件（对话/旁白）。

        角色行优先用标记（*动作*、「说话」）还原多段；若旧数据没有标记，
        则尽量复用此前已保存的结构化事件，避免编辑后整段被压成一说。
        """
        char_names = {self.characters.display_name(cid) for cid in self.characters.all_ids()}
        pname = self.characters.user_identity.get("name", "玩家")
        prior_chars = []
        for ev in (prior or []):
            if ev.get("type") == "character":
                seq = ev.get("sequence") or []
                text = " ".join((s.get("text") or "") for s in seq)
                if ev.get("name") and text:
                    prior_chars.append({
                        "name": ev.get("name"),
                        "text": text,
                        "thought": ev.get("thought", ""),
                        "sequence": seq,
                    })
        events = []
        for i, line in enumerate(self.scene_history):
            m = re.match(r"^\[([^\]]+)\]\s*([\s\S]*)$", line)
            if not m:
                events.append({"type": "scene", "text": line, "sceneIndex": i})
                continue
            name, rest = m.group(1), m.group(2).strip()
            if name in char_names:
                segs = _parse_marked_segments(rest)
                thought = ""
                if len(segs) == 1 and not re.search(r"\*|「", rest or ""):
                    # 旧的无标记行：尽量沿用此前保存的多段结构
                    for pc in prior_chars:
                        if pc["name"] == name and (
                                rest in pc["text"] or pc["text"] in rest or rest == pc["text"]):
                            segs = pc["sequence"]
                            thought = pc["thought"]
                            break
                events.append({
                    "type": "character", "name": name, "thought": thought,
                    "sequence": segs, "silent": False,
                    "character": self.characters.resolve(name) or name,
                    "sceneIndex": i,
                })
            elif name == pname:
                events.append({"type": "player", "name": name, "text": rest, "sceneIndex": i})
            else:
                label = "背景" if name in ("旁白", "背景") else name
                events.append({"type": "scene", "name": label, "text": rest, "sceneIndex": i})
        return events

    def _migrate_structured_history(self):
        """把旧的纯文本 scene_history 一次性转成结构化事件，供前端富渲染。"""
        self.structured_history = self._infer_structured_from_scene()
        self._save_meta()

    def _assign_scene_indexes(self):
        """为结构化事件补上对应的 scene_history 索引（旧数据迁移）。

        player/character/scene 事件与 scene_history 行按顺序一一对应；
        补齐后前端编辑就能**精确编辑那一条**，不再因内容重复而错选到最后一行。
        """
        if not self.structured_history:
            return
        if any(e.get("sceneIndex") is not None for e in self.structured_history):
            return
        scene_ev = [i for i, e in enumerate(self.structured_history)
                    if e.get("type") in ("player", "character", "scene")]
        if not scene_ev or len(scene_ev) > len(self.scene_history):
            return
        for ev_pos, line_idx in zip(scene_ev, range(len(self.scene_history))):
            self.structured_history[ev_pos]["sceneIndex"] = line_idx
        self._save_meta()

    def _migrate_opening_background(self):
        """把旧会话里只存在于 scene_history 的开场“旁白”补成“背景”，并写入会话世界状态。"""
        if self.world.background.get("background"):
            return
        if not self.scene_history:
            return
        first = self.scene_history[0] or ""
        m = re.match(r"^\[(旁白|背景)\]\s*([\s\S]*)$", first)
        if not m:
            return
        text = m.group(2).strip()
        if not text:
            return
        self.world.background["background"] = text
        self.world.save_background()
        self.scene_history[0] = f"[背景] {text}"
        for ev in self.structured_history:
            if ev.get("type") == "scene" and ev.get("name") in ("旁白", "背景"):
                ev["name"] = "背景"
                ev["text"] = text
                break
        else:
            self.structured_history.insert(0, {"type": "scene", "name": "背景", "text": text})
        self._save_meta()

    def _strip_transient_history(self):
        """去掉历史中已持久化的瞬时事件（记忆总结/世界与角色更新/遗忘），避免残留“还在总结”。"""
        transient = {"memory_summary", "world_update", "character_update", "forget"}
        before = len(self.structured_history)
        self.structured_history = [
            e for e in self.structured_history
            if not (isinstance(e, dict) and e.get("type") in transient)
        ]
        if len(self.structured_history) != before:
            self._save_meta()

    def rebuild_structured_from_scene(self):
        """编辑/删除/回溯后，让结构化历史与 scene_history 保持一致。"""
        self.structured_history = self._infer_structured_from_scene(self.structured_history)
        self._save_meta()

    # ---------- 依赖注入 ----------
    def get_embedder(self) -> Embedder:
        """返回进程内共享的嵌入器（模型只加载一次）。

        嵌入依赖（torch / sentence-transformers）与模型文件都是可选组件，
        缺失时这里会抛 EmbeddingUnavailable，调用方（记忆检索）会自动退回 BM25。
        """
        if self._embedder is None:
            from embedding import get_shared_embedder

            self._embedder = get_shared_embedder()
        return self._embedder

    def get_memory(self, character_id: str) -> CharacterMemory:
        if character_id not in self.memory_cache:
            self.memory_cache[character_id] = CharacterMemory(
                character_id, self.get_embedder)
        return self.memory_cache[character_id]

    # ---------- 会话元信息 ----------
    def _load_meta(self) -> dict:
        if os.path.exists(self.session_meta_path):
            with open(self.session_meta_path, encoding="utf-8") as f:
                return json.load(f)
        return {}

    def _save_meta(self):
        os.makedirs(CONFIG["STATE_DIR"], exist_ok=True)
        with open(self.session_meta_path, "w", encoding="utf-8") as f:
            json.dump({
                "scene_history": self.scene_history,
                "player_update_hints": self.player_update_hints,
                "world_update_hints": self.world_update_hints,
                "world_directives": self.world_directives,
                "structured_history": self.structured_history[-500:],
                "show_thought": self.show_thought,
                "rounds_since_forget": self.rounds_since_forget,
                "turn_counter": self._turn_counter,
                "story_mode": self.story_mode,
                "world_entry_activations": self.world_entry_activations,
            }, f, ensure_ascii=False, indent=2)

    def save_session(self):
        self.world.save()
        self.characters.save()
        for memory in self.memory_cache.values():
            memory.save()
        self._save_meta()

    # ---------- 事件收集 ----------
    def _emit(self, kind: str, payload: dict):
        event = {"type": kind, **payload}
        self.turn_events.append(event)
        if self._on_event:
            self._on_event(event)

    def new_request_id(self):
        self.request_id = uuid.uuid4().hex[:12]
        # 关键：登记本次 request_id 属于哪个会话，保证 LLM 调用/事件能落到正确日志文件。
        set_request_session(self.request_id, self.session_id)
        return self.request_id

    # ---------- 存档点 ----------
    def snapshots_dir(self):
        return os.path.join(self.session_dir, "snapshots") if self.session_dir else None

    def create_snapshot(self, label="", auto=False, scene_cut=None) -> dict:
        chars = []
        for cid in self.characters.all_ids():
            rec = self.characters.get(cid)
            chars.append({
                "id": cid,
                "card": copy.deepcopy(rec["card"]),
                "state": copy.deepcopy(rec["state"]),
                "is_core": rec["is_core"],
            })
        memory = {}
        for cid in self.characters.all_ids():
            try:
                memory[cid] = self.get_memory(cid).export()
            except Exception:  # noqa: BLE001
                memory[cid] = {}
        return {
            "label": label,
            "auto": bool(auto),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "scene_index": len(self.scene_history),
            "cut_scene_index": scene_cut,
            "turn_counter": self._turn_counter,
            "world": copy.deepcopy(self.world.background),
            "timeline": list(self.world.timeline),
            "perception": copy.deepcopy(self.world.perception),
            "scene_history": list(self.scene_history),
            "structured_history": list(self.structured_history),
            "show_thought": self.show_thought,
            "world_directives": list(self.world_directives),
            "user_identity": copy.deepcopy(self.characters.user_identity),
            "characters": chars,
            "memory": memory,
        }

    def save_snapshot(self, label="", auto=False, scene_cut=None):
        snap = self.create_snapshot(label=label, auto=auto, scene_cut=scene_cut)
        d = self.snapshots_dir()
        if not d:
            return None
        os.makedirs(d, exist_ok=True)
        snap_id = time.strftime("%Y%m%d%H%M%S") + "_" + os.urandom(2).hex()
        with open(os.path.join(d, f"{snap_id}.json"), "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False, indent=2)
        self._trim_auto_snapshots(d)
        return {"id": snap_id, "label": snap["label"], "created_at": snap["created_at"], "auto": snap["auto"]}

    def _trim_auto_snapshots(self, d):
        max_n = int(CONFIG.get("SNAPSHOT_MAX", 20) or 20)
        autos = []
        for name in os.listdir(d):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(d, name), encoding="utf-8") as f:
                try:
                    data = json.load(f)
                except Exception:  # noqa: BLE001
                    continue
            if data.get("auto"):
                autos.append((os.path.join(d, name), data.get("created_at", "")))
        autos.sort(key=lambda x: x[1])
        while len(autos) > max_n:
            try:
                os.remove(autos.pop(0)[0])
            except OSError:
                break

    def list_snapshots(self) -> list:
        d = self.snapshots_dir()
        if not d or not os.path.isdir(d):
            return []
        out = []
        for name in os.listdir(d):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(d, name), encoding="utf-8") as f:
                try:
                    data = json.load(f)
                except Exception:  # noqa: BLE001
                    continue
            out.append({
                "id": name[:-5],
                "label": data.get("label", ""),
                "created_at": data.get("created_at", ""),
                "auto": bool(data.get("auto")),
                "scene_index": data.get("scene_index", 0),
                "characters": len(data.get("characters", [])),
            })
        out.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return out

    def delete_snapshot(self, snap_id: str) -> bool:
        d = self.snapshots_dir()
        if not d:
            return False
        p = os.path.join(d, f"{snap_id}.json")
        if os.path.exists(p):
            os.remove(p)
            return True
        return False

    def get_snapshot_path(self, snap_id: str) -> str:
        d = self.snapshots_dir()
        if not d:
            return ""
        p = os.path.join(d, f"{snap_id}.json")
        return p if os.path.exists(p) else ""

    def _maybe_auto_snapshot(self):
        interval = int(CONFIG.get("SNAPSHOT_INTERVAL", 0) or 0)
        if interval <= 0:
            return
        self._snap_counter = getattr(self, "_snap_counter", 0) + 1
        if self._snap_counter >= interval:
            self._snap_counter = 0
            try:
                self.save_snapshot(label=tr("自动存档"), auto=True)
            except Exception:  # noqa: BLE001
                pass

    def restore_snapshot_into_current(self, snap: dict) -> bool:
        if not self.session_dir:
            return False
        # 就地恢复世界与感知
        self.world.background = copy.deepcopy(snap.get("world") or {})
        self.world.timeline = list(snap.get("timeline") or [])
        self.world.perception = dict(snap.get("perception") or {})
        if isinstance(self.world.perception.get("details"), list):
            from world_state import _normalize_details
            self.world.perception["details"] = _normalize_details(
                self.world.perception.get("details"))
        self.world.save()
        # 就地恢复角色卡与状态
        for ch in snap.get("characters") or []:
            cid = ch.get("id") or ""
            rec = self.characters.get(cid)
            if not rec:
                continue
            card = copy.deepcopy(ch.get("card") or {})
            card["id"] = cid
            rec["card"] = card
            rec["state"] = copy.deepcopy(ch.get("state") or {})
        self.characters.save()
        # 就地恢复记忆
        self.memory_cache = {}
        for cid, mem in (snap.get("memory") or {}).items():
            try:
                self.get_memory(cid).import_data(mem)
            except Exception:  # noqa: BLE001
                pass
        self.scene_history = list(snap.get("scene_history") or [])
        self.structured_history = list(snap.get("structured_history") or [])
        self._turn_counter = int(snap.get("turn_counter", self._turn_counter) or 0)
        self.world_entry_activations = list(snap.get("world_entry_activations") or [])
        self.show_thought = bool(snap.get("show_thought", self.show_thought))
        self.world_directives = list(snap.get("world_directives") or [])
        self._save_meta()
        return True

    # ---------- 回合回退（AI 重写）----------
    def _rewinds_path(self):
        if not self.session_dir:
            return None
        return os.path.join(self.session_dir, "rewinds.json")

    def _load_rewinds(self) -> list:
        p = self._rewinds_path()
        if p and os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as f:
                    data = json.load(f)
                return data if isinstance(data, list) else []
            except Exception:  # noqa: BLE001
                return []
        return []

    def _save_rewinds(self):
        p = self._rewinds_path()
        if not p:
            return
        max_n = int(CONFIG.get("REWIND_MAX_TURNS", 10) or 0)
        stack = self.rewind_stack[-max_n:] if max_n > 0 else []
        with open(p, "w", encoding="utf-8") as f:
            json.dump(stack, f, ensure_ascii=False, indent=2)

    def _capture_rewind(self, player_input: str, segments):
        max_n = int(CONFIG.get("REWIND_MAX_TURNS", 10) or 0)
        if max_n <= 0:
            return
        try:
            snap = self.create_snapshot(label="", auto=True)
            snap["structured_history"] = list(self.structured_history)
            snap["player_input"] = player_input
            snap["segments"] = segments
            self.rewind_stack.append(snap)
            if len(self.rewind_stack) > max_n:
                self.rewind_stack = self.rewind_stack[-max_n:]
            self._save_rewinds()
        except Exception:  # noqa: BLE001
            pass

    def rewind_last_turn(self) -> dict:
        """恢复上一回合执行前的状态，并从玩家 Agent 重新开始这一回合。

        重写前先用 turn_seq 把“目标回合及其之后”的近期记忆彻底丢弃，避免被拒绝的
        重写结果残留在角色上下文的“近期事件”里。
        """
        if not self.rewind_stack:
            return {"ok": False, "error": tr("没有可重写的回合（可先在设置里开启回合回退）")}
        # 丢弃本回合尚未落盘的近期记忆（重写会重新生成，避免旧版本被写入）。
        self._pending_memory_ops = {}
        snap = self.rewind_stack[-1]
        ok = self.restore_snapshot_into_current(snap)
        if not ok:
            return {"ok": False, "error": tr("当前会话不支持回退")}
        self.structured_history = list(snap.get("structured_history") or [])
        # 目标回合序号 = 快照时刻的回合数 + 1（下一回合将被重新执行的回合）。
        target_seq = int(snap.get("turn_counter", 0) or 0) + 1
        self._discard_working_from_turn(target_seq)
        # 重写会从快照时刻重新推进环境，因此清空“环境增量”缓存，避免沿用它回合的旧值。
        self._last_working_ctx = None
        player_input = snap.get("player_input", "")
        segments = snap.get("segments")
        self._save_meta()
        self._emit("rewind_state", {"state": self.snapshot_state()})
        self._rewinding = True
        try:
            result = self.handle_player_input(player_input, segments)
        finally:
            self._rewinding = False
        return {"ok": True, **result}

    def _sync_rewind_input(self, index: int, player_input: str,
                           segments: list | None = None):
        """编辑某条消息后，同步对应重写快照的 player_input/segments，使重写遵循编辑后的内容。"""
        for snap in self.rewind_stack:
            si = snap.get("scene_index")
            if si is not None and int(si) == index:
                snap["player_input"] = player_input
                snap["segments"] = segments
        self._save_rewinds()

    def sync_rewind_player_edit(self, index: int, player_input: str):
        """交互模式：编辑玩家消息后，让重写使用编辑后的玩家输入。"""
        self._sync_rewind_input(index, player_input, None)

    def edit_story_turn(self, scene_index: int, text: str, directive: str) -> dict:
        """编辑一条剧情总结：更新文本与指令，并让重写遵循编辑后的指令。"""
        if scene_index < 0 or scene_index >= len(self.scene_history):
            return {"ok": False, "error": tr("历史条目不存在")}
        if not self.scene_history[scene_index].startswith("[剧情总结]"):
            return {"ok": False, "error": tr("该条目不是剧情总结")}
        text = (text or "").strip()
        directive = (directive or "").strip()
        self.scene_history[scene_index] = f"[剧情总结] {text}"
        found = False
        for ev in self.structured_history:
            if not isinstance(ev, dict):
                continue
            if ev.get("sceneIndex") != scene_index:
                continue
            if ev.get("type") == "story":
                ev["text"] = text
                ev["directive"] = directive
                ev["segments"] = _parse_marked_segments(text)
                found = True
                break
            if ev.get("type") == "scene" and ev.get("name") == "剧情总结":
                ev.clear()
                ev.update({
                    "type": "story", "text": text, "directive": directive,
                    "segments": _parse_marked_segments(text), "sceneIndex": scene_index,
                })
                found = True
                break
        if not found:
            self.structured_history.append({
                "type": "story", "text": text, "directive": directive,
                "segments": _parse_marked_segments(text), "sceneIndex": scene_index,
            })
        self._sync_rewind_input(scene_index, directive, None)
        self._save_meta()
        return {"ok": True, "state": self.snapshot_state()}

    def _discard_working_from_turn(self, target_seq: int):
        """把内存中目标回合及之后写入的近期记忆全部清除。"""
        if target_seq is None:
            return
        for cid in list(self.memory_cache.keys()):
            try:
                self.get_memory(cid).discard_from_turn(target_seq)
            except Exception:  # noqa: BLE001
                pass

    # ---------- 世界指令 ----------
    def _active_directive_text(self) -> str:
        """返回当前生效的世界指令文本（用于注入提示词）。"""
        if not self.world_directives:
            return ""
        now = self.world.current_time_iso()
        try:
            now_dt = parse_time(now)
        except Exception:  # noqa: BLE001
            now_dt = None
        lines = []
        for d in self.world_directives:
            start = d.get("start") or ""
            end = d.get("end") or ""
            if not start and not end:
                lines.append(d.get("text", ""))
                continue
            try:
                if now_dt is not None:
                    ok = True
                    if start:
                        ok = ok and now_dt >= parse_time(start)
                    if end:
                        ok = ok and now_dt <= parse_time(end)
                    if ok:
                        lines.append(d.get("text", ""))
            except Exception:  # noqa: BLE001
                continue
        if not lines:
            return ""
        return "\n".join(f"- {t}" for t in lines)

    # ---------- 世界书词条（设定）关键词触发 ----------
    def _world_entries_source(self) -> list:
        """当前会话可用的世界书词条（设定），来自合并后的 worldbook.json。"""
        data = self.world.worldbook if hasattr(self.world, "worldbook") else {}
        return card_schema.world_entries(data)

    def _hit_entries(self, text: str) -> list:
        """根据玩家输入/最近上下文，返回命中的世界书词条。"""
        needle = (text or "").strip()
        if not needle:
            return []
        hay = needle.lower()
        hits = []
        seen = set()
        for entry in self._world_entries_source() or []:
            key = entry.get("key")
            if key in seen:
                continue
            keywords = entry.get("keywords") or []
            matched = False
            for k in keywords:
                k = str(k).strip()
                if not k:
                    continue
                kl = k.lower()
                # 直接命中：关键词是输入的子串
                if kl in hay:
                    matched = True
                    break
                # 去除括号核心词（如 “学生（湮没众神）” -> “学生”）
                core = re.sub(r"（[^）]*）|\([^)]*\)", "", k).strip()
                if len(core) >= 2 and core.lower() in hay:
                    matched = True
                    break
                # 输入是关键词的子串（用户输了“学生”而关键词是“学生（湮没众神）”）
                if len(k) >= 2 and hay in kl:
                    matched = True
                    break
            if matched:
                hits.append(entry)
                seen.add(key)
        return hits

    def _register_world_entry_hits(self, text: str):
        """每回合调用：衰减已有词条，登记本轮命中，并按重要度/新旧裁剪到上限。"""
        depth = int(CONFIG.get("WORLDBOOK_ENTRY_DEPTH", 2) or 2)
        max_n = int(CONFIG.get("WORLDBOOK_ENTRY_MAX", 4) or 4)
        # 1) 衰减
        for act in self.world_entry_activations:
            act["remaining"] = max(0, int(act.get("remaining", depth)) - 1)
        # 2) 新命中 / 刷新
        for entry in self._hit_entries(text):
            key = entry.get("key")
            found = next((a for a in self.world_entry_activations if a.get("key") == key), None)
            if found:
                found["remaining"] = depth
                found["hit_turn"] = self._turn_counter
            else:
                self.world_entry_activations.append({
                    "key": key,
                    "name": entry.get("name", ""),
                    "importance": float(entry.get("importance", 0.5)),
                    "info": entry.get("info", ""),
                    "keywords": entry.get("keywords", []),
                    "hit_turn": self._turn_counter,
                    "remaining": depth,
                })
        # 3) 去掉到期的
        self.world_entry_activations = [
            a for a in self.world_entry_activations
            if int(a.get("remaining", 0)) > 0
        ]
        # 4) 按“重要度降序、命中更早者先移除”裁剪，仅保留最新命中的重要词条
        self.world_entry_activations.sort(
            key=lambda a: (-float(a.get("importance", 0.5)), int(a.get("hit_turn", 0))))
        self.world_entry_activations = self.world_entry_activations[:max_n]
        self._save_meta()

    def _world_entry_context(self) -> str:
        """生成要插入提示词的世界书词条块（重要度降序）。"""
        acts = sorted(
            self.world_entry_activations,
            key=lambda a: (-float(a.get("importance", 0.5)), int(a.get("hit_turn", 0))),
        )
        if not acts:
            return ""
        lines = [""]
        for a in acts:
            name = a.get("name") or a.get("key") or ""
            info = a.get("info") or ""
            lines.append(f"- {name}：{info}" if name else f"- {info}")
        return "\n".join(lines)

    def _summarize_scene_old(self, old_lines: list) -> str:
        """把较早的情节（已超出近期窗口的部分）浓缩成一小段摘要，供前置到近期事件。"""
        text = "\n".join(old_lines)
        if not text.strip():
            return ""
        messages = [
            {"role": "system", "content": get_prompt("memory_summary")},
            {"role": "user", "content": (
                "请把下面这段较早的情节浓缩成 1~3 条「事件」，每条保留关键人物、地点与转折，"
                "只输出 JSON：\n" + text)},
        ]
        try:
            out = self.llm.complete_json(
                "memory_summary", messages,
                default={"events": [{"summary": text[:120], "importance": 0.5}]},
                request_id=self.request_id)
            parts = []
            for ev in out.get("events") or []:
                if isinstance(ev, dict):
                    s = (ev.get("summary") or "").strip()
                else:
                    s = str(ev).strip()
                if s:
                    parts.append(s)
            return ("（此前情节摘要）" + "；".join(parts)) if parts else ""
        except Exception:  # noqa: BLE001  总结失败不阻塞，回退为无摘要
            return ""

    def _recent_events_block(self, scene_history: list, limit: int = None,
                             ratio: float = None) -> str:
        """给玩家/环境 Agent 的「近期事件」：超过限制时，把较旧部分总结后前置到最近回合。

        保留的最近回合数 = min(limit, round(总行数 * (1-ratio)))；ratio 与记忆总结共用
        WORKING_SUMMARIZE_RATIO。这样既保留最近细节，又不丢失更早的关键情节。
        """
        limit = int(limit if limit is not None else CONFIG["SCENE_HISTORY_LIMIT"])
        ratio = max(0.0, min(1.0, float(
            ratio if ratio is not None else CONFIG["WORKING_SUMMARIZE_RATIO"])))
        lines = _scene_lines(scene_history)
        if not lines:
            return "（暂无）"
        if len(lines) <= limit:
            return "\n".join(lines)
        keep_count = min(limit, max(1, round(len(lines) * (1.0 - ratio))))
        older = lines[:-keep_count]
        recent = lines[-keep_count:]
        summary = self._summarize_scene_old(older)
        return (summary + "\n" + "\n".join(recent)).strip() or "（暂无）"

    # ---------- 一轮玩家输入 ----------
    def handle_player_input(self, player_input: str, segments: list | None = None) -> dict:
        # 用会话级锁把“回合处理”与“后台世界/角色更新”串行化，避免数据竞争。
        with self._update_lock:
            self._flush_pending_memory()
            if self.story_mode:
                return self._handle_story_input(player_input)
            return self._handle_player_input_locked(player_input, segments)

    def _flush_pending_memory(self):
        """把上一回合延后的近期记忆真正写入各角色：先落盘，再总结旧部分。

        之所以延后：若玩家对上一段剧情/角色回复不满意并重写，这期间记忆还没落盘；
        重写会清空 pending 并重新生成，避免把“被重写掉的版本”写进近期/长期记忆。
        """
        if not self._pending_memory_ops:
            return
        ops_by_char = self._pending_memory_ops
        self._pending_memory_ops = {}
        for cid, ops in ops_by_char.items():
            try:
                memory = self.get_memory(cid)
                for op in ops:
                    if op.get("front"):
                        segs = []
                        for seg in op.get("segs") or []:
                            if isinstance(seg, dict):
                                segs.append((seg.get("type", "speech"), seg.get("text", "")))
                            else:
                                segs.append(("speech", seg))
                        joined = WorldSession._join_marked(segs)
                        if joined:
                            memory.append_working(op["front"], joined, turn_seq=op.get("turn_seq"))
                    else:
                        memory.append_working(op["speaker"], op["text"], op.get("context"),
                                              op.get("turn_seq"))
                self._maybe_summarize_working_memory(memory)
                memory.save()
            except Exception:  # noqa: BLE001
                pass

    def _handle_story_input(self, directive: str) -> dict:
        """故事模式：只用长文本模型续写一段剧情，并交给环境 Agent 像普通对话那样维护环境。"""
        directive = (directive or "").strip()
        self.turn_events = []
        self.new_request_id()
        set_request_session(self.request_id, self.session_id)
        if not self._rewinding:
            self._capture_rewind(directive, None)
        self._turn_counter += 1
        turn_seq = self._turn_counter
        prev_time = self.world.world_clock_iso()
        turn_time = self.world.perception.get("time") or ""
        self._emit("processing", {"text": tr("正在谱写剧情…")})

        # 世界书命中：以玩家指令为准（空指令则无命中）。
        self._register_world_entry_hits(directive)
        world_entry_text = self._world_entry_context()
        world_summary = self.world.world_summary()
        perception = self.world.current_environment_text()
        recent = self._recent_events_block(self.scene_history)
        directive_block = directive if directive else "（无指令，自然推进剧情）"
        scene_char_block = self._scene_char_cards_block()

        messages = [
            {"role": "system", "content": get_prompt("story")},
            {"role": "user", "content": (
                f"【世界背景】\n{world_summary}\n\n"
                f"【当前环境】\n{perception}\n\n"
                f"【在场角色】\n{scene_char_block}\n\n"
                f"【近期剧情】\n{recent}\n\n"
                f"【玩家指令】\n{directive_block}\n\n"
                "请续写一段剧情，只输出 JSON。"
            )},
        ]
        try:
            out = self.llm.complete_json(
                "story", messages, default={"text": ""}, request_id=self.request_id)
        except Exception as e:  # noqa: BLE001
            log_event(self.request_id or "", "story_failed", {"error": str(e)},
                      session_id=self.session_id)
            self._emit("error", {"text": tr("剧情生成失败：{err}", err=e)})
            return {"player_message": None, "events": self.turn_events,
                    "state": self.snapshot_state()}

        text = (out.get("text") or "").strip()
        if not text:
            self._emit("error", {"text": tr("剧情生成结果为空")})
            return {"player_message": None, "events": self.turn_events,
                    "state": self.snapshot_state()}

        # 先落地并渲染剧情（故事模式：剧情在前，环境更新在后）。
        scene_index = len(self.scene_history)
        self.scene_history.append(f"[剧情总结] {text}")
        segments = _parse_marked_segments(text)
        story_event = {"type": "story", "text": text, "sceneIndex": scene_index,
                       "segments": segments, "directive": directive, "ts": time.time(),
                       "ptime": turn_time}
        self._emit("story", {
            "text": text, "segments": segments, "sceneIndex": scene_index,
            "directive": directive,
        })

        # 再把剧情交给环境 Agent，让它像普通对话那样维护环境（时间/地点/天气/细节/在场角色）。
        prev_perception = dict(self.world.perception)
        env_out = self.env_agent.process(
            text, [], list(self.scene_history), self.request_id,
            directive_block, world_entry_text, recent)
        for hint in env_out.get("hints") or []:
            self._emit("hint", {"text": hint})
        self._collect_update_hints(env_out)
        self._apply_environment(env_out.get("environment") or {})
        env_event = self._build_environment_event(
            prev_perception, env_out.get("environment") or {})
        if env_event is not None:
            self._emit("environment", env_event)

        # 环境变化 + 剧情文本写入近期记忆，切回交互模式后被当作普通消息带去上下文。
        turn_ctx = self._working_context()
        env_change_text = self._format_env_change(turn_ctx)
        scene_chars = self._resolve_scene_characters(env_out, {"invoke": []})
        mem_targets = [c["cid"] for c in scene_chars]
        if not mem_targets:
            for cid in self.characters.all_ids():
                rec = self.characters.get(cid)
                if rec and rec.get("is_core"):
                    mem_targets.append(cid)

        for cid in mem_targets:
            # 延迟到玩家发下一条再落盘，重写剧情时可整体回退。
            ops = self._pending_memory_ops.setdefault(cid, [])
            if env_change_text:
                ops.append({"speaker": "环境", "text": env_change_text, "turn_seq": turn_seq})
            ops.append({"speaker": "剧情总结", "text": text, "turn_seq": turn_seq})

        self.structured_history.append(story_event)
        self.structured_history = self.structured_history[-500:]
        # 时间跨过更新节点后，让后台世界/角色更新照常触发。
        self._schedule_background_update(prev_time, self.world.world_clock_iso(), world_entry_text)
        self.save_session()
        log_event(self.request_id, "turn_done",
                  {"events": [e["type"] for e in self.turn_events]},
                  session_id=self.session_id)
        return {"player_message": None, "events": self.turn_events,
                "state": self.snapshot_state()}

    def _scene_char_cards_block(self) -> str:
        """当前场景角色的角色卡摘要（供剧情节写时贴合人物设定）。无场景角色时返回占位。"""
        names = []
        for item in self.world.perception.get("scene_characters") or []:
            raw = item.get("name") if isinstance(item, dict) else str(item)
            if str(raw or "").strip():
                names.append(str(raw).strip())
        parts = []
        for n in names:
            cid = self.characters.resolve(n)
            if not cid:
                parts.append(f"- {n}（无角色卡，按名字描述）")
                continue
            card = self.characters.render_card(cid)
            if card:
                parts.append(f"- {n}：{card[:800]}")
            else:
                parts.append(f"- {n}（无卡）")
        return "\n".join(parts) or "（暂无）"

    def _handle_player_input_locked(self, player_input: str, segments: list | None = None) -> dict:
        player_input = player_input.strip()
        self.turn_events = []
        self.new_request_id()
        set_request_session(self.request_id, self.session_id)
        if not player_input:
            return {"player_message": None, "events": [], "state": self.snapshot_state()}
        if player_input and not self._rewinding:
            self._capture_rewind(player_input, segments)

        prev_perception = dict(self.world.perception)
        prev_time = self.world.world_clock_iso()
        turn_time = prev_perception.get("time") or ""
        # 玩家输入里的「令」（think 段）转成一次性【世界指令】：本回合生效、下回合自动消失。
        one_shot_directive = self._extract_directive(segments)
        directive_text = self._active_directive_text()
        if one_shot_directive:
            directive_text = ((directive_text + "\n" if directive_text else "")
                              + one_shot_directive).strip()
            self._emit("hint", {"text": tr("你下达了世界指令，本回合生效：{text}", text=one_shot_directive)})
        self._turn_counter += 1
        turn_seq = self._turn_counter
        self._register_world_entry_hits(player_input)
        world_entry_text = self._world_entry_context()
        self._emit("processing", {"text": tr("正在理解你的行动…")})
        recent_events = self._recent_events_block(self.scene_history)
        player_out = self.player_agent.process(
            player_input, self.scene_history, request_id=self.request_id,
            directive=directive_text, world_entries=world_entry_text,
            recent_events=recent_events)
        # 玩家 Agent 额外输出的「剧情走向」：只注入本回合的环境/前台，不注入玩家 Agent 自己，
        # 也不写进持久世界指令（下一回合自动消失）。
        plot = str(player_out.get("plot") or "").strip()
        plot_directive = f"{plot}"
        scene_directive = directive_text
        if plot:
            scene_directive = ((directive_text + "\n" if directive_text else "")
                               + plot_directive).strip()
        user_name = self.characters.user_identity.get("name", "玩家")
        player_message = {"name": user_name, "text": player_input}
        player_line = f"[{user_name}] {player_input}"
        player_scene_index = len(self.scene_history)
        if not (self.scene_history and self.scene_history[-1] == player_line):
            self.scene_history.append(player_line)
        else:
            player_scene_index = len(self.scene_history) - 1

        # 可观测环境 Agent 放后台并行生成；角色前台仍串行（后续角色能看到前面角色的表现）。
        resolved_invoke = []
        for item in player_out.get("invoke") or []:
            raw_cid = item.get("character", "")
            resolved = self.characters.resolve(raw_cid)
            cid = resolved or raw_cid
            info = item.get("info", "")
            if not resolved:
                log_event(self.request_id, "cardless_character",
                          {"referenced": raw_cid, "info": info},
                          session_id=self.session_id)
            resolved_invoke.append({
                "cid": cid, "resolved": resolved, "info": info,
                "name": self.characters.display_name(cid),
            })

        scene_context_parts = []  # 本回合前面角色的表现，供后续角色参考
        front_results = []        # [(cid, name, front, scene_line_index)]
        # 先按上一轮环境的隔离标记做初步显示；本轮环境结果随后再应用。
        prev_isolated_names = {
            c.get("name") for c in (self.world.perception.get("scene_characters") or [])
            if isinstance(c, dict) and c.get("isolated")
        }
        # 先在“角色前台”串行生成所有角色（后续角色能看到前面角色的表现），
        # 并把它们的输出即时写入 scene_history，供随后调用的环境 Agent 感知整场。
        for ri in resolved_invoke:
            self._emit("processing", {"text": tr("{name} 正在回应…", name=ri["name"]), "character": ri["cid"]})
            scene_context = "\n".join(scene_context_parts)
            raw_front = self.front_agent.act(
                ri["cid"], player_input, scene_context=scene_context, info=ri["info"],
                request_id=self.request_id, directive=scene_directive,
                world_entries=world_entry_text, isolated=False)
            front = self._front_for_role(ri["cid"], raw_front, ri["name"] in prev_isolated_names)
            flat = self._flatten_front_output(ri["name"], front)
            line_index = len(self.scene_history)
            if flat:
                scene_context_parts.append(flat)
                self.scene_history.append(flat)
            else:
                line_index = len(self.scene_history) - 1
            # 一个角色生成完立刻显示，不用等环境 Agent。
            sequence = front.get("sequence") or []
            self._emit("character", {
                "character": ri["cid"],
                "name": ri["name"],
                "thought": front.get("thought", ""),
                "sequence": sequence,
                "rendered": render_front_turn(ri["name"], front, self.show_thought),
                "silent": not (sequence or front.get("thought")),
                "sceneIndex": line_index,
                "ptime": turn_time,
            })
            front_results.append((ri["cid"], ri["name"], front, line_index))

        # 再调用环境 Agent（此时 scene_history 已包含玩家 + 所有角色），维护环境。
        # 环境 Agent 的「近期事件」仍用本回合之前的近史，避免与本回合角色表现重复。
        try:
            env_out = self.env_agent.process(
                player_input, player_out.get("invoke") or [], list(self.scene_history),
                self.request_id, scene_directive, world_entry_text, recent_events,
                scene_context="\n".join(scene_context_parts))
        except Exception as e:  # noqa: BLE001
            log_event(self.request_id or "", "environment_agent_failed",
                      {"error": str(e)}, session_id=self.session_id)
            env_out = {"environment": {}, "hints": [], "update_hints": [],
                       "world_update_hints": []}

        # 应用环境（暂不 emit 事件，等角色显示之后再统一 emit，和剧情总结的顺序一致：先内容、后环境）。
        self._collect_update_hints(env_out)
        self._apply_environment(env_out.get("environment") or {})
        env_event = self._build_environment_event(
            prev_perception, env_out.get("environment") or {})

        scene_chars = self._resolve_scene_characters(env_out, player_out)
        # 离场保护：上一轮在场、本轮不在（也未被调用）→ 冻结该角色记忆；直到再次被明确调用才恢复。
        present = {ch["cid"] for ch in scene_chars}
        env_gave = bool((env_out.get("environment") or {}).get("scene_characters"))
        if not env_gave:
            # 环境本轮没给 scene_characters（稀疏更新）：沿用感知里仍在场的角色，避免误判“安静在场者”离场。
            for item in self.world.perception.get("scene_characters") or []:
                raw = item.get("name") if isinstance(item, dict) else str(item)
                cid = self.characters.resolve(str(raw or "")) or str(raw or "")
                if cid:
                    present.add(cid)
        invoked_cids = {cid for cid, _n, _f, _l in front_results}
        for cid in (self._scene_members_last - present):
            self._scene_left.add(cid)
        for cid in invoked_cids:
            self._scene_left.discard(cid)
        self._scene_members_last = set(present)
        # 角色已即时显示；环境更新紧随其后。
        for hint in env_out.get("hints") or []:
            self._emit("hint", {"text": hint})
        if env_event is not None:
            self._emit("environment", env_event)

        # 环境更新后，再统一写入近期记忆（用更新后的环境快照，供日后总结还原场景）。
        # 以当前场景角色列表为准：即使角色没被调用，也写入整场事件（玩家 + 所有角色言行，不含思考）；
        # 特殊私密场景（如打电话）中只写玩家与该角色的交谈。
        invoked = {cid: (name, front) for cid, name, front, _line in front_results}
        isolated_cids_for_mem = {c["cid"] for c in scene_chars if c["isolated"]}
        shared_fronts = [(cid, name, front) for cid, name, front, _line in front_results
                         if cid not in isolated_cids_for_mem]
        player_all = self._player_segments(player_input, segments, speech_only=False)
        player_speech = self._player_segments(player_input, segments, speech_only=True)
        # 本回合的环境增量只计算一次：时间作为「回合锚点」放在玩家消息上；
        # 地点/天气/环境细节的变化单独记一条「环境」记录；其余对话子消息不带任何环境信息。
        turn_ctx = self._working_context()
        player_time_ctx = {}
        if turn_ctx.get("time"):
            player_time_ctx["time"] = turn_ctx["time"]
        env_change_text = self._format_env_change(turn_ctx)
        for ch in scene_chars:
            cid = ch["cid"]
            if cid in self._scene_left:
                # 已离场的角色：本回合近景记忆不写入，避免把离场之后其他角色的剧情塞给它。
                continue
            ops = self._pending_memory_ops.setdefault(cid, [])
            if ch["isolated"]:
                # 私密场景：只写玩家说的话 + 该角色自己的回应。
                joined_p = WorldSession._join_marked(player_speech)
                if joined_p:
                    ops.append({"speaker": user_name, "text": joined_p,
                                "context": player_time_ctx, "turn_seq": turn_seq})
                if cid in invoked:
                    _, front = invoked[cid]
                    ops.append({"front": self.characters.full_display_name(cid),
                                "segs": front.get("sequence") or [], "turn_seq": turn_seq})
            else:
                # 共享场景：环境变化记一条「环境」记录（只写变化，不贴在每句对话上）。
                if env_change_text:
                    ops.append({"speaker": "环境", "text": env_change_text, "turn_seq": turn_seq})
                joined_p = WorldSession._join_marked(player_all)
                if joined_p:
                    ops.append({"speaker": user_name, "text": joined_p,
                                "context": player_time_ctx, "turn_seq": turn_seq})
                # 记录整场：被调用的角色都写进在场角色的记忆（否则角色理解不了其它角色行动）。
                for cid2, _name, front in shared_fronts:
                    ops.append({"front": self.characters.full_display_name(cid2),
                                "segs": front.get("sequence") or [], "turn_seq": turn_seq})
        # 本回合的近期记忆延迟到「玩家发下一条」再落盘，方便重写时回退，不被污染。

        next_time = self.world.world_clock_iso()
        self._schedule_background_update(prev_time, next_time, world_entry_text)
        self._maybe_forget()
        player_event = {"type": "player", "name": user_name, "text": player_input}
        player_event["sceneIndex"] = player_scene_index
        if segments:
            player_event["segments"] = segments
        now_ts = time.time()
        player_event["ts"] = now_ts
        player_event["ptime"] = turn_time
        persistable = [player_event]
        for ev in self.turn_events:
            # 处理中/增量/记忆总结/遗忘都只是瞬时状态，不写入永久历史。
            if ev.get("type") in (
                "processing", "character_delta", "memory_summary", "forget",
                "world_update", "character_update",
            ):
                continue
            ev["ts"] = now_ts
            if ev.get("type") != "environment":
                ev["ptime"] = turn_time
            persistable.append(ev)
        self.structured_history.extend(persistable)
        self.structured_history = self.structured_history[-500:]
        self.save_session()
        self._maybe_auto_snapshot()
        log_event(self.request_id, "turn_done",
                  {"events": [e["type"] for e in self.turn_events]},
                  session_id=self.session_id)
        return {
            "player_message": player_message,
            "events": self.turn_events,
            "state": self.snapshot_state(),
        }

    def _build_environment_event(self, prev: dict, env: dict) -> dict:
        perception = self.world.perception
        keys = ("time", "location", "weather", "details", "scene_characters")
        changed = [k for k in keys if perception.get(k) != prev.get(k)]
        if not changed and not env:
            return None
        return {
            "perception": {k: perception.get(k) for k in keys},
            "changed": changed,
        }

    def _apply_environment(self, env: dict):
        """应用可观测环境 Agent 的 environment：更新感知，缺省时自然推进时间。"""
        env = env or {}
        # 新格式：稀疏更新（只刷新生变的条目）；兼容旧格式：整环境替换。
        if "updates" in env:
            scene = env.get("scene_characters")
            if isinstance(scene, list):
                self.world.perception["scene_characters"] = self._normalize_scene_characters(scene)
            self.world.apply_environment_updates(env.get("updates") or [])
            return
        if any(k in env for k in ("time", "location", "weather", "details")):
            scene = env.get("scene_characters")
            if isinstance(scene, list):
                self.world.perception["scene_characters"] = self._normalize_scene_characters(scene)
            self.world.update_perception(env)
            if not env.get("time"):
                self.world.advance_default()
            return
        # environment 为空 / 只含 hints：仍按默认节奏推进时间，保持旧行为。
        self.world.advance_default()

    def _collect_update_hints(self, env_out: dict):
        """收集可观测环境 Agent 的附加信息，分别给角色更新与世界更新。"""
        for h in (env_out or {}).get("update_hints") or []:
            if str(h).strip():
                self.player_update_hints.append(h)
                self.world_update_hints.append(h)

    @staticmethod
    def _front_for_role(cid: str, raw_front: dict, isolated: bool) -> dict:
        """隔离（私密）角色：只保留说话，不把动作渲染给玩家/在场其他角色。"""
        if not isolated:
            return raw_front
        seq = []
        for seg in raw_front.get("sequence") or []:
            if isinstance(seg, dict) and seg.get("type") == "speech":
                text = (seg.get("text") or "").strip()
                if text:
                    seq.append({"type": "speech", "text": text})
        return {
            "character_id": raw_front.get("character_id", cid),
            "thought": raw_front.get("thought", ""),
            "sequence": seq,
        }

    @staticmethod
    def _normalize_scene_characters(scene: list) -> list:
        """把环境 Agent 的场景角色列表归一化为 [{name, isolated}]。"""
        out = []
        seen = set()
        for item in scene:
            if isinstance(item, str):
                name = item.strip()
                isolated = False
            elif isinstance(item, dict):
                name = str(item.get("character") or item.get("name") or "").strip()
                isolated = bool(item.get("isolated"))
            else:
                continue
            if not name or name in seen:
                continue
            seen.add(name)
            out.append({"name": name, "isolated": isolated})
        return out

    def _resolve_scene_characters(self, env_out: dict, player_out: dict) -> list:
        """把当前场景角色解析为 [{cid, isolated}]，并并入玩家 Agent 明确调用的角色。"""
        scene = []
        seen = set()
        env = (env_out or {}).get("environment") or {}
        for item in env.get("scene_characters") or []:
            if isinstance(item, str):
                raw = item.strip()
                isolated = False
            elif isinstance(item, dict):
                raw = str(item.get("character") or item.get("name") or "").strip()
                isolated = bool(item.get("isolated"))
            else:
                continue
            cid = self.characters.resolve(raw) or raw
            if cid and cid not in seen:
                seen.add(cid)
                scene.append({"cid": cid, "isolated": isolated})
        for item in (player_out or {}).get("invoke") or []:
            raw = item.get("character") or ""
            cid = self.characters.resolve(raw) or raw
            if cid and cid not in seen:
                seen.add(cid)
                scene.append({"cid": cid, "isolated": False})
        return scene

    @staticmethod
    def _display_segment(stype: str, text: str) -> str:
        """把一段内容渲染成带标记的形式：说 →「…」，做 →*…*；已带标记则原样返回。"""
        text = (text or "").strip()
        if not text:
            return ""
        if stype == "raw":
            # 非 precise 输入无法判断是说/做，保留原文，不强制加标记。
            return text
        if stype == "action":
            if text.startswith("*") and text.endswith("*"):
                return text
            return f"*{text}*"
        # 说话 / 未知：统一补「」
        if text.startswith("「") and text.endswith("」"):
            return text
        return f"「{text}」"

    @staticmethod
    def _join_marked(segs) -> str:
        """把 [(type, text), ...] 合成一句带标记文本：说 →「…」，做 →*…*。"""
        parts = []
        for stype, stext in segs:
            norm = WorldSession._display_segment(stype, stext)
            if norm:
                parts.append(norm)
        return " ".join(parts)

    @staticmethod
    def _player_segments(player_input: str, segments: list,
                         speech_only: bool = False) -> list:
        """把玩家输入拆成一条条 (type, text)，precise 模式下每条独立、过滤思考。

        非 precise（无 segments）时返回单个 ('raw', player_input)，保持原文。
        """
        segs = segments or []
        if not segs:
            text = (player_input or "").strip()
            return [("raw", text)] if text else []
        out = []
        for s in segs:
            if not isinstance(s, dict):
                continue
            stype = s.get("type", "speech")
            if stype == "think":
                continue  # 玩家思考暂禁，不写入近期记忆
            if speech_only and stype != "speech":
                continue
            text = str(s.get("text") or "").strip()
            if text:
                out.append((stype, text))
        return out

    @staticmethod
    def _extract_directive(segments: list) -> str:
        """从玩家输入里提取「令」（think 段）文本，作为一次性世界指令。"""
        if not segments:
            return ""
        texts = []
        for s in segments:
            if isinstance(s, dict) and s.get("type") == "think":
                t = str(s.get("text") or "").strip()
                if t:
                    texts.append(t)
        return "\n".join(texts)

    @staticmethod
    def _append_front_mem(memory, name: str, front: dict, turn_seq: int = None):
        """把角色前台的 sequence 合并成一条近期记忆（名字只出现一次，说用「」、做用* *）。"""
        segs = []
        for seg in front.get("sequence") or []:
            if isinstance(seg, dict):
                segs.append((seg.get("type", "speech"), seg.get("text", "")))
            else:
                segs.append(("speech", seg))
        joined = WorldSession._join_marked(segs)
        if joined:
            memory.append_working(name, joined, turn_seq=turn_seq)

    @staticmethod
    def _flatten_front_output(name: str, front: dict) -> str:
        """把角色前台输出压成一行 `[名字] 「说话」 *动作*`，供场景上下文/历史使用。"""
        segs = []
        for seg in front.get("sequence") or []:
            text = (seg.get("text") or "").strip()
            if text:
                segs.append((seg.get("type", "speech"), text))
        joined = WorldSession._join_marked(segs)
        if not joined:
            return ""
        return f"[{name}] {joined}"

    # ---------- 近期记忆总结 ----------
    def _working_context(self) -> dict:
        """记录本回合相对上次的「环境增量」，供总结时还原场景。

        避免重复写入整段环境：时间/地点/天气用标量比较；环境细节按 id 逐条比较，
        仅收录新增/变更的条目。无变化时返回空 dict，近期记忆里就不会再凭空多出环境信息。
        """
        p = self.world.perception or {}
        details = p.get("details") or []
        detail_map = {}
        for d in details:
            if isinstance(d, dict):
                text = str(d.get("text") or "").strip()
                if text:
                    # 以“文本”作为稳定键：环境条目改变文本即视为变化；新增/删除也能正确识别。
                    detail_map[text] = text
            else:
                text = str(d).strip()
                if text:
                    detail_map[text] = text
        cur = {
            "time": p.get("time") or self.world.current_time_iso(),
            "location": p.get("location") or "",
            "weather": p.get("weather") or "",
            "details": detail_map,
        }
        last = self._last_working_ctx
        self._last_working_ctx = cur
        if last is None:
            # 首个回合：把初始环境写一次（供总结还原开场），此后只记录变化。
            out = {}
            if cur.get("time"):
                out["time"] = cur["time"]
            if cur.get("location"):
                out["location"] = cur["location"]
            if cur.get("weather"):
                out["weather"] = cur["weather"]
            init_env = "；".join(detail_map.values())
            if init_env:
                out["environment"] = init_env
            return out
        out = {}
        for key, value in cur.items():
            if key == "details":
                continue
            if last.get(key) != value:
                out[key] = value
        # 环境细节：只记录新增/改动的条目（按 id 对齐），删除的条目不进近期记忆。
        changed_texts = []
        cur_details = cur.get("details") or {}
        last_details = last.get("details") or {}
        for did in set(cur_details) | set(last_details):
            cur_text = cur_details.get(did)
            last_text = last_details.get(did)
            if cur_text != last_text and cur_text:
                changed_texts.append(cur_text)
        if changed_texts:
            out["environment"] = "；".join(changed_texts)
        return out

    @staticmethod
    def _format_env_change(delta: dict) -> str:
        """把环境增量（仅变化部分）渲染成一条「环境」记录文本；只有时间变化时返回空串。"""
        parts = []
        if delta.get("location"):
            parts.append(f"地点：{delta['location']}")
        if delta.get("weather"):
            parts.append(f"天气：{delta['weather']}")
        if delta.get("environment"):
            parts.append(f"环境变化：{delta['environment']}")
        return "；".join(parts)

    def _memory_summary_context(self, character_id: str) -> str:
        """为记忆总结提供世界观、角色卡、状态与环境，让总结贴合角色视角。"""
        rec = self.characters.get(character_id)
        card = self.characters.render_card(character_id) if rec else ""
        world = self.world.world_summary()
        perception = self.world.current_environment_text()
        return (
            f"【世界背景】\n{world}\n\n"
            f"【角色卡】\n{card or '（无）'}\n\n"
            f"【当前环境】\n{perception}"
        )

    def _maybe_summarize_working_memory(self, memory: CharacterMemory):
        total = len(memory.working_text())
        if total < CONFIG["WORKING_MEMORY_LIMIT"]:
            return
        # 先按“近期记忆标记”截断已形成长期记忆的旧条目；标记耗尽仍超容时才回退到总结。
        result = memory.trim_working_memory()
        if result is None:
            return
        to_summarize, kept, text = (
            result["to_summarize"], result["kept"], result["text"])
        if len(text) < CONFIG["MIN_SUMMARIZE_CHARS"]:
            return
        self._emit("memory_summary", {
            "character": memory.character_id,
            "chars": total,
            "detail": f"{memory.character_id} 近期记忆已达 {total} 字，正在总结旧部分……",
        })
        context_info = self._memory_summary_context(memory.character_id)
        self._emit("processing", {"text": tr("正在后台整理并总结记忆…（可继续发送）")})
        # 后台总结：不阻塞本回合，总结期间用户仍可继续发消息、调用各模型。
        threading.Thread(
            target=self._summarize_worker,
            args=(memory, text, context_info, kept, self.request_id, self.session_id,
                  self.world.current_time_iso()),
            daemon=True,
        ).start()

    def _summarize_worker(self, memory: CharacterMemory, text: str, context_info: str,
                          kept, request_id: str, session_id: str, event_time: str):
        try:
            summarize_and_store(memory, text, "conversation", self.llm,
                                request_id=request_id, context_info=context_info,
                                event_time=event_time)
            memory.working_memory = kept
            memory.save()
        except Exception as e:  # noqa: BLE001  后台总结失败不阻塞主流程
            log_event(request_id or "", "memory_summary_failed",
                      {"error": str(e)}, session_id=session_id)

    # ---------- 更新节奏 ----------
    def _schedule_background_update(self, prev_time: str, next_time: str,
                                    world_entries: str = ""):
        """把角色/世界更新调度到后台线程；生成阶段不持锁，前台仍可继续发消息。

        LLM 生成（较慢）在后台线程进行，阶段二才短锁写入状态/长期记忆/嵌入；
        产生的通知先收集到 self.pending_updates，前端轮询状态后拉取并确认。
        """
        if not crossed_time(prev_time, next_time, CONFIG["UPDATE_TIME"]):
            return
        self.background_update_active = True
        # 快照附加信息，避免后台生成期间被后续回合改写
        player_hints = list(self.player_update_hints)
        world_hints = list(self.world_update_hints)
        # 立即清空：后台生成期间新回合会重新累积新的附加信息，避免被本轮的清空误删
        self.player_update_hints = []
        self.world_update_hints = []
        threading.Thread(
            target=self._background_update_worker,
            args=(prev_time, next_time, world_entries, player_hints, world_hints),
            daemon=True,
        ).start()

    def _background_update_worker(self, prev_time: str, next_time: str,
                                  world_entries: str = "",
                                  player_hints: list = None,
                                  world_hints: list = None):
        try:
            # 阶段一：LLM 生成不持锁；阶段二在 _advance_update_cycle 内短锁应用。
            events = self._advance_update_cycle(
                prev_time, next_time, world_entries, collect=[],
                player_hints=player_hints, world_hints=world_hints,
            ) or []
            if events:
                self.pending_updates.extend(events)
                self._save_meta()
        except Exception as e:  # noqa: BLE001  后台更新失败不阻塞主流程，写日志便于定位
            log_event(self.request_id or "", "background_update_failed",
                      {"error": str(e)}, session_id=self.session_id)
        finally:
            self.background_update_active = False
            self.background_update_status = ""

    def _advance_update_cycle(self, prev_time: str, next_time: str,
                              world_entries: str = "", collect: list = None,
                              player_hints: list = None,
                              world_hints: list = None) -> list:
        """推进一轮世界/角色更新（后台专用）。

        阶段一：不持锁调用各 Agent 的 generate()（LLM 较慢，期间前台可继续发消息，
                规划/长期记忆仍沿用旧值）。
        阶段二：短锁调用 apply()，写入状态/长期记忆（含嵌入）；这里才是真正
                “信息落地”的一段，也才有进度提示。
        """
        if not crossed_time(prev_time, next_time, CONFIG["UPDATE_TIME"]):
            return collect or []
        emit = collect is None
        update_window = self.world.update_window_text()
        directive = self._active_directive_text()
        window_start = self.world.last_update_time()
        player_hints = player_hints if player_hints is not None else list(self.player_update_hints)
        world_hints = world_hints if world_hints is not None else list(self.world_update_hints)

        # ===== 阶段一：LLM 生成（不持锁）=====
        self.background_update_status = "正在生成更新结果…（后台进行中，可继续发送）"
        fresh_world, fresh_char = [], []
        if CONFIG["UPDATE_WORLD_FIRST"]:
            wreq = self._bg_request_id()
            fresh_world = self.world_update_agent.generate(
                world_hints, self.last_character_update_summary,
                request_id=wreq, world_entries=world_entries,
                update_window=update_window, directive=directive)
            creq = self._bg_request_id()
            fresh_char = self.character_update_agent.generate(
                player_hints, request_id=creq, world_changes=fresh_world,
                world_entries=world_entries, update_window=update_window,
                directive=directive)
        else:
            creq = self._bg_request_id()
            fresh_char = self.character_update_agent.generate(
                player_hints, request_id=creq, world_changes=None,
                world_entries=world_entries, update_window=update_window,
                directive=directive)
            char_summary = self._flatten_char_summary(fresh_char)
            wreq = self._bg_request_id()
            fresh_world = self.world_update_agent.generate(
                world_hints, char_summary, request_id=wreq,
                world_entries=world_entries, update_window=update_window,
                directive=directive)

        # ===== 阶段二：应用（短锁，写状态 / 长期记忆 / 嵌入）=====
        self.background_update_status = "正在写入更新结果与记忆…"
        applied, wchanges = [], []
        with self._update_lock:
            if CONFIG["UPDATE_WORLD_FIRST"]:
                wchanges = self.world_update_agent.apply(fresh_world)
                self._emit_or_collect("world_update", {
                    "changes": wchanges, "rendered": render_world_changes(wchanges),
                }, emit, collect)
                applied = self.character_update_agent.apply(
                    fresh_char, request_id=creq, window_start=window_start)
                self._emit_or_collect("character_update", {
                    "updated": [self.characters.display_name(u["character"]) for u in applied],
                }, emit, collect)
            else:
                applied = self.character_update_agent.apply(
                    fresh_char, request_id=creq, window_start=window_start)
                self._emit_or_collect("character_update", {
                    "updated": [self.characters.display_name(u["character"]) for u in applied],
                }, emit, collect)
                wchanges = self.world_update_agent.apply(fresh_world)
                self._emit_or_collect("world_update", {
                    "changes": wchanges, "rendered": render_world_changes(wchanges),
                }, emit, collect)
            self.world.set_last_update_time(self.world.current_time_iso())
            self.world.save()
            self.characters.save()

        self.last_character_update_summary = applied or self.last_character_update_summary
        self._save_meta()
        return collect or []

    def _bg_request_id(self) -> str:
        """为后台更新生成独立的 request_id（不与前台回合串号），并登记会话。"""
        rid = uuid.uuid4().hex[:12]
        set_request_session(rid, self.session_id)
        return rid

    @staticmethod
    def _flatten_char_summary(fetched: list) -> list:
        """把 generate() 得到的各批次 updates 展平为 [{character: cid}]，供世界更新参考。"""
        out = []
        for batch in fetched or []:
            for upd in batch or []:
                if isinstance(upd, dict) and upd.get("character"):
                    out.append({"character": upd["character"]})
        return out

    def _emit_or_collect(self, kind: str, payload: dict, emit: bool,
                         collect: list):
        if emit:
            self._emit(kind, payload)
        elif collect is not None:
            collect.append({"type": kind, **payload})

    def _run_world_update(self, fresh_character_summary=None, world_entries: str = "",
                          update_window: str = None, emit: bool = True,
                          collect: list = None):
        # 手动更新也可能与后台更新并发，统一在此处加锁。
        with self._update_lock:
            if CONFIG["UPDATE_NOTICE"] and emit:
                self._emit("processing", {"text": tr("正在更新世界…")})
            self.new_request_id()  # 手动/自动更新都各用一个 request_id，保证日志归属正确会话
            summary = fresh_character_summary if fresh_character_summary is not None else self.last_character_update_summary
            win = update_window or self.world.update_window_text()
            changes = self.world_update_agent.run(
                self.world_update_hints, summary,
                request_id=self.request_id, world_entries=world_entries, update_window=win,
                directive=self._active_directive_text())
            payload = {
                "changes": changes,
                "rendered": render_world_changes(changes),
            }
            if emit:
                self._emit("world_update", payload)
            elif collect is not None and changes:
                collect.append({"type": "world_update", **payload})
            if update_window is None:
                self.world.set_last_update_time(self.world.current_time_iso())
            self.world.save()
            return changes

    def _run_character_update(self, fresh_world_changes=None, world_entries: str = "",
                              update_window: str = None, emit: bool = True,
                              collect: list = None):
        # 手动更新也可能与后台更新并发，统一在此处加锁。
        with self._update_lock:
            if CONFIG["UPDATE_NOTICE"] and emit:
                self._emit("processing", {"text": tr("正在更新角色状态与规划…")})
            self.new_request_id()
            win = update_window or self.world.update_window_text()
            updated = self.character_update_agent.run(
                self.player_update_hints, world_changes=fresh_world_changes,
                request_id=self.request_id, world_entries=world_entries, update_window=win,
                directive=self._active_directive_text())
            names = [self.characters.display_name(u["character"]) for u in updated]
            payload = {"updated": names}
            if emit:
                self._emit("character_update", payload)
            elif collect is not None and updated:
                collect.append({"type": "character_update", **payload})
            if update_window is None:
                self.world.set_last_update_time(self.world.current_time_iso())
            self.characters.save()
            return updated

    def request_manual_update(self, target: str) -> dict:
        """把“手动更新世界/角色”改为后台执行：立即返回，不阻塞前台输入。

        手动更新期间用户仍可继续发消息；结果通过 pending_updates 由前端轮询消费，
        进度由 background_update_status 提供给界面展示。
        """
        self.background_update_active = True
        self.background_update_status = "正在生成更新结果…（后台进行中，可继续发送）"
        threading.Thread(target=self._manual_update_worker, args=(target,), daemon=True).start()
        return {"ok": True}

    def _manual_update_worker(self, target: str):
        try:
            # 两阶段：生成（不持锁，后台可继续发消息）+ 应用（短锁写入），与自动更新一致。
            if target == "character":
                self.background_update_status = "正在生成角色更新与记忆…（后台进行中）"
                creq = self._bg_request_id()
                win = self.world.update_window_text()
                window_start = self.world.last_update_time()
                fetched = self.character_update_agent.generate(
                    self.player_update_hints, request_id=creq, world_changes=None,
                    world_entries="", update_window=win,
                    directive=self._active_directive_text())
                self.background_update_status = "正在写入角色更新与记忆…"
                with self._update_lock:
                    applied = self.character_update_agent.apply(
                        fetched, request_id=creq, window_start=window_start)
                    self.world.set_last_update_time(self.world.current_time_iso())
                    self.characters.save()
                self.last_character_update_summary = applied or self.last_character_update_summary
                if applied:
                    self.pending_updates.append({
                        "type": "character_update",
                        "updated": [self.characters.display_name(u["character"]) for u in applied],
                    })
            else:
                self.background_update_status = "正在生成世界更新…（后台进行中）"
                wreq = self._bg_request_id()
                win = self.world.update_window_text()
                changes = self.world_update_agent.generate(
                    self.world_update_hints, self.last_character_update_summary,
                    request_id=wreq, world_entries="", update_window=win,
                    directive=self._active_directive_text())
                self.background_update_status = "正在写入世界更新…"
                with self._update_lock:
                    applied = self.world_update_agent.apply(changes)
                    self.world.set_last_update_time(self.world.current_time_iso())
                    self.world.save()
                if applied:
                    self.pending_updates.append({
                        "type": "world_update", "changes": applied,
                        "rendered": render_world_changes(applied),
                    })
            self._save_meta()
        except Exception as e:  # noqa: BLE001
            log_event(self.request_id or "", "manual_update_failed",
                      {"error": str(e)}, session_id=self.session_id)
        finally:
            self.background_update_active = False
            self.background_update_status = ""

    def ack_updates(self):
        """前端消费完 pending_updates 后调用，清空待通知。"""
        self.pending_updates = []
        return {"ok": True}

    def _maybe_forget(self):
        self.rounds_since_forget += 1
        if self.rounds_since_forget < CONFIG["FORGET_CHECK_EVERY_K_TURNS"]:
            return
        self.rounds_since_forget = 0
        for memory in self.memory_cache.values():
            if memory.forget():
                self._emit("forget", {
                    "character": memory.character_id,
                    "event_count": len(memory.events),
                })

    # ---------- 会话初始化 ----------
    def initialize_from_hint(self, hint: str) -> dict:
        """根据玩家提示词 + 世界书 + 角色卡，生成开场世界状态。"""
        self.new_request_id()
        set_request_session(self.request_id, self.session_id)
        world_text = self.world.world_summary(include_background=False)
        bg = self.world.world_background()
        world_block = world_text
        if bg:
            world_block += f"\n\n【背景】\n{bg}"
        locations_text = self.world.location_context_text()
        if locations_text:
            world_block += f"\n\n【已知地点】\n{locations_text}"
        core_only = bool(read_core_only_update())
        char_summaries = self.characters.render_all_summaries(core_only=core_only)
        user_name = self.characters.user_identity.get("name", "玩家")

        user_content = (
            f"【世界书摘要】\n{world_block}\n\n"
            f"【所有角色摘要】\n{char_summaries}\n\n"
            f"【玩家提示】\n{hint or '（未提供，按世界书默认开场）'}\n\n"
        )
        messages = [
            {"role": "system", "content": get_prompt("session_init")},
            {"role": "user", "content": user_content},
        ]
        default = {
            "time": CONFIG["START_TIME"],
            "location": "",
            "weather": "晴朗",
            "scene_summary": "",
            "details": [],
            "character_plans": {},
        }
        try:
            out = self.llm.complete_json(
                "session_init", messages, default=default, request_id=self.request_id)
        except Exception as e:  # noqa: BLE001
            log_event(self.request_id, "session_init_failed", {"error": str(e)},
                      session_id=self.session_id)
            # 把失败原因带回前端：否则界面只看到一个“空预览”，
            # 用户会以为“点了没反应 / 根本没调用模型”。
            out = {**default, "error": str(e)}
        return out

    def apply_init(self, init: dict):
        """把确认后的开场状态写入当前会话（时间、地点、天气、环境、角色状态）。"""
        env = {}
        if init.get("time"):
            env["time"] = init["time"]
        if init.get("location"):
            env["location"] = init["location"]
        if init.get("weather"):
            env["weather"] = init["weather"]
        if isinstance(init.get("details"), list):
            env["details"] = init["details"]
        if env:
            env.setdefault("details", [])
            self.world.update_perception(env)
            # 会话开始的时钟作为“上次更新时间”的初始值，保证首个更新时段是“开始~当前”。
            self.world.set_last_update_time(self.world.current_time_iso())
            self.world.save_background()
        for cid, plan in (init.get("character_plans") or {}).items():
            # 模型给出的 key 可能是角色 id，也可能是中文名（如「爱丽丝」），需解析为 cid。
            resolved = self.characters.resolve(cid)
            if not resolved:
                continue
            # 仅核心角色更新开启时，普通角色不写入开场规划。
            if bool(read_core_only_update()):
                rec = self.characters.get(resolved)
                if not rec or not rec["is_core"]:
                    continue
            if isinstance(plan, (dict, list)):
                self.characters.update_state(
                    resolved, {"current_plan": card_schema.normalize_plan(plan)})
                self.characters.save_state(resolved)
        # 开场“背景”既写入会话世界状态（供所有 Agent 使用），也作为一条场景历史展示给玩家。
        summary = init.get("scene_summary") or ""
        if summary:
            self.world.background["background"] = summary
            self.world.save_background()
            self.scene_history.insert(0, f"[背景] {summary}")
            self.structured_history.insert(0, {
                "type": "scene", "name": "背景", "text": summary,
            })
            self._save_meta()
        self.save_session()

    # ---------- 状态快照 ----------
    def snapshot_state(self) -> dict:
        chars = []
        for cid in self.characters.all_ids():
            rec = self.characters.get(cid)
            state = rec["state"]
            mem = None
            if cid in self.memory_cache:
                mem = self.memory_cache[cid].stats()
            plans = card_schema.normalize_plan(state.get("current_plan") or state.get("plan"))
            plan_loc = ""
            plan_doing = ""
            if plans:
                first = plans[0]
                plan_loc = str(first.get("place") or "")
                plan_doing = str(first.get("action") or "")
            chars.append({
                "id": cid,
                "name": self.characters.display_name(cid),
                "surname": rec["card"].get("surname", ""),
                "is_core": rec["is_core"],
                "intro": rec["card"].get("intro", "") or rec["card"].get("identity", ""),
                "location": state.get("location") or plan_loc,
                "mood": state.get("mood", ""),
                "doing": state.get("doing") or plan_doing,
                "avatar": card_schema.normalize_avatar(rec["card"].get("avatar", "")),
                "memory_stats": mem,
            })
        loc_raw = self.world.perception.get("location", "")
        loc_locs = card_schema.world_locations(self.world.background)
        loc_found = card_schema.find_location_path(loc_locs, loc_raw)
        location = " › ".join(loc_found["path"]) if loc_found and loc_found.get("path") else loc_raw
        # 让 scene_history 窗口与 structured_history 的 sceneIndex 对齐：
        # 结构化事件里的 sceneIndex 是“绝对”的（指向完整 scene_history），而前端拿到的是窗口切片，
        # 若不重定位，前端会用绝对索引去查切片后的数组，导致编辑/删除/存点错行（修改后无效/顶替角色行）。
        events = self.structured_history[-300:]
        idxs = [int(e.get("sceneIndex")) for e in events
                if isinstance(e.get("sceneIndex"), int) and e.get("sceneIndex") is not None]
        start = min(idxs) if idxs else 0
        scene_window = self.scene_history[start:]
        rebased = []
        for e in events:
            e2 = dict(e)
            si = e2.get("sceneIndex")
            if isinstance(si, int) and si is not None and start <= si < len(self.scene_history):
                e2["sceneIndex"] = si - start
            else:
                e2.pop("sceneIndex", None)
            rebased.append(e2)
        return {
            "clock": self.world.perception.get("time") or self.world.current_time_iso(),
            "location": location,
            "weather": self.world.perception.get("weather", ""),
            "perception": self.world.perception,
            "world_summary": self.world.world_summary(),
            "world_meta": {
                "overview": (self.world.background or {}).get("overview", ""),
                "background": (self.world.background or {}).get("background", ""),
                "tone": (self.world.background or {}).get("tone", ""),
            },
            "timeline": self.world.recent_timeline(30),
            "scene_history": scene_window,
            "structured_history": rebased,
            "scene_start": start,
            "show_thought": self.show_thought,
            "story_mode": bool(self.story_mode),
            "user_identity": copy.deepcopy(self.characters.user_identity),
            "manual_time_advance": bool(CONFIG.get("ENABLE_MANUAL_TIME_ADVANCE", True)),
            "manual_update": bool(CONFIG.get("UPDATE_ENABLE_MANUAL_UPDATE", True)),
            "characters": chars,
            "background_update_active": bool(self.background_update_active),
            "background_update_status": self.background_update_status,
            "pending_updates": list(self.pending_updates),
            "locations": card_schema.world_locations(self.world.background),
        }

    def assist(self, mode: str) -> dict:
        """帮玩家生成/重写一句话。非破坏性，仅返回建议，由前端填入输入框。"""
        self.new_request_id()
        set_request_session(self.request_id, self.session_id)
        user_name = self.characters.user_identity.get("name", "玩家")
        last_player = ""
        for line in reversed(self.scene_history):
            m = re.match(r"^\[([^\]]+)\]\s*([\s\S]*)$", line)
            if m and m.group(1) == user_name:
                last_player = m.group(2).strip()
                break

        timeline_lines = []
        for ev in self.world.recent_timeline(8):
            timeline_lines.append(
                f"[{ev.get('time', '')}] {ev.get('place', '')}：{ev.get('description', '')}")
        timeline = "\n".join(timeline_lines) or "（暂无）"
        # 帮写/重写只给近期信息，避免把整段世界与所有角色摘要塞进来让 prompt 过长。
        perception = self.world.current_environment_text()
        history_text = _recent_player_history(self.scene_history, 8)
        directive_text = self._active_directive_text()
        directive_block = f"\n\n【世界指令】\n{directive_text}" if directive_text else ""

        if mode == "rewrite":
            task = (
                f"玩家上一句是：\n{last_player or '（暂无）'}\n\n"
                "请以玩家视角，重写出一句更自然、更贴合当前剧情与人物关系的行动或对话，"
                "只重写玩家自己的话。"
            )
        else:
            task = "请以玩家视角，帮玩家想一句接下来可以说或做的事，贴合当前环境、时间点与剧情走向。"

        messages = [
            {"role": "system", "content": _build_system(
                "assist", _world_identity_block(self.world, self.characters))},
            {"role": "user", "content": (
                f"【近期世界变化】\n{timeline}\n\n"
                f"{directive_block}\n\n"
                f"【当前环境】\n{perception}\n\n"
                f"【近期历史】\n{history_text}\n\n"
                f"【任务】\n{task}\n"
                "只输出 JSON。"
            )},
        ]
        try:
            out = self.llm.complete_json(
                "assist", messages, default={"text": ""}, request_id=self.request_id)
        except Exception as e:  # noqa: BLE001
            return {"text": "", "segments": None, "error": str(e)}
        segs = []
        for seg in out.get("segments") or []:
            if not isinstance(seg, dict):
                continue
            stype = "action" if seg.get("type") == "action" else "speech"
            stext = (seg.get("text") or "").strip()
            if stext:
                segs.append({"type": stype, "text": stext})
        return {"text": (out.get("text") or "").strip(), "segments": segs or None}
