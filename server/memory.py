"""
单角色长期记忆
===========================
要点：
  - 事件 = 长期记忆的最小且唯一单位
  - 事件摘要的嵌入向量直接存成本地文件：
        state/memory/<character_id>.vec.pkl    {event_id: 向量}
  - 检索 = BM25 关键词 + 嵌入相似度（文件向量算余弦）+ 重要性 + 时效性，再按权重排序。
  - 近期记忆超过阈值后，按比例切分，把旧部分交给 LLM 总结成一个个事件。

持久化：
  state/memory/<character_id>.json     事件、近期记忆、序号
  state/memory/<character_id>.bm25.pkl 每角色的 BM25 索引
  state/memory/<character_id>.vec.pkl  每角色的嵌入向量（文件存，不再用 Milvus）
"""
import json
import os
import pickle

import jieba
import numpy as np
from rank_bm25 import BM25Okapi

from embedding import Embedder
from settings import CONFIG, read_memory_retrieval


def _clamp_float(value, default: float = 0.5) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, v))


def _norm(vals: dict) -> dict:
    """把一组分数 0-1 归一化；若没有差异则都记为 1.0，避免除零。"""
    if not vals:
        return {}
    lo, hi = min(vals.values()), max(vals.values())
    if hi == lo:
        return {k: 1.0 for k in vals}
    return {k: (v - lo) / (hi - lo) for k, v in vals.items()}


def _vec_path(character_id: str) -> str:
    return os.path.join(CONFIG["MEMORY_DIR"], f"{character_id}.vec.pkl")


def _load_vectors(character_id: str) -> dict:
    p = _vec_path(character_id)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return pickle.load(f)
    return {}


def _save_vectors(character_id: str, vectors: dict) -> None:
    os.makedirs(CONFIG["MEMORY_DIR"], exist_ok=True)
    with open(_vec_path(character_id), "wb") as f:
        pickle.dump(vectors, f)


def _delete_vec(character_id: str, eid: str) -> None:
    vectors = _load_vectors(character_id)
    if eid in vectors:
        del vectors[eid]
        _save_vectors(character_id, vectors)


def _delete_vectors(character_id: str) -> None:
    p = _vec_path(character_id)
    if os.path.exists(p):
        try:
            os.remove(p)
        except OSError:
            pass


class CharacterMemory:
    """单角色的长期记忆：仅事件，向量存本地文件，BM25 每角色一份。"""

    def __init__(self, character_id: str, embedder=None):
        self.character_id = character_id
        self.base_name = os.path.join(CONFIG["MEMORY_DIR"], character_id)
        self.json_path = self.base_name + ".json"
        self.bm25_path = self.base_name + ".bm25.pkl"
        # 懒加载：只有真正需要嵌入（检索/写入）时才建模型。
        self._embedder = None
        self._embedder_factory = None
        if callable(embedder):
            self._embedder_factory = embedder
        elif embedder is not None:
            self._embedder = embedder

        self.events = {}
        self.time_seq = 0
        self.next_event_id = 1
        self.working_memory = []
        # 「近期记忆标记」：更新 agent 已把标记之前的条目转成长期记忆，
        # 因此这些条目在超容时可直接截断；标记消耗完后仍超容则回退到总结。
        self.working_memory_mark = 0
        self._vec_checked = False
        self._vec_cache = None
        self.load()

    def _embed(self):
        if self._embedder is None:
            self._embedder = (
                self._embedder_factory()
                if self._embedder_factory is not None
                else Embedder()
            )
        return self._embedder

    # ---------- 持久化 ----------
    @staticmethod
    def _normalize_events(raw) -> dict:
        """兼容新旧格式：保留 event_id/source/summary/importance/time_seq/time。"""
        events = {}
        if not raw:
            return events
        items = raw.items() if isinstance(raw, dict) else (
            (e.get("event_id"), e) for e in raw if isinstance(e, dict))
        for eid, ev in items:
            if not isinstance(ev, dict):
                continue
            summary = (ev.get("summary") or ev.get("event_summary") or "").strip()
            if not summary:
                continue
            eid = eid or ev.get("event_id")
            if not eid:
                continue
            events[eid] = {
                "event_id": eid,
                "source": ev.get("source") or "conversation",
                "summary": summary[:500],
                "importance": _clamp_float(ev.get("importance"), 0.5),
                "time_seq": int(ev.get("time_seq", 0)),
                "time": ev.get("time") or "",
            }
        return events

    def load(self):
        if not os.path.exists(self.json_path):
            return
        with open(self.json_path, encoding="utf-8") as f:
            data = json.load(f)
        self.events = self._normalize_events(data.get("events") or {})
        self.time_seq = int(data.get("time_seq", 0))
        self.next_event_id = int(data.get("next_event_id", 1))
        self.working_memory = data.get("working_memory", []) or []
        self.working_memory_mark = int(data.get("working_memory_mark", 0) or 0)
        self._vec_checked = False

    def save(self):
        os.makedirs(CONFIG["MEMORY_DIR"], exist_ok=True)
        with open(self.json_path, "w", encoding="utf-8") as f:
            json.dump({
                "character_id": self.character_id,
                "time_seq": self.time_seq,
                "next_event_id": self.next_event_id,
                "events": self.events,
                "working_memory": self.working_memory,
                "working_memory_mark": self.working_memory_mark,
            }, f, ensure_ascii=False, indent=2)

    def export(self) -> dict:
        """导出为可序列化字典（事件 + 近期记忆，不含向量；向量在各角色 vec 文件）。"""
        return {
            "character_id": self.character_id,
            "time_seq": self.time_seq,
            "next_event_id": self.next_event_id,
            "events": self.events,
            "working_memory": self.working_memory,
        }

    def import_data(self, data: dict):
        """从 export() 的 dict 恢复记忆。

        事件向量存各角色 vec 文件（按 character_id 命名），这里只重建事件与 BM25，
        不再全量重嵌向量；缺失的向量由首次检索的 _ensure_vectors 按需补齐，
        从而让“AI 重写/回溯”等恢复场景不再被全量嵌入拖慢。
        """
        self.character_id = data.get("character_id", self.character_id)
        self.time_seq = int(data.get("time_seq", 0))
        self.next_event_id = int(data.get("next_event_id", 1))
        self.events = self._normalize_events(data.get("events") or {})
        self.working_memory = data.get("working_memory", []) or []
        self.working_memory_mark = int(data.get("working_memory_mark", 0) or 0)
        # 重建 BM25；向量交给 _ensure_vectors 按需补齐（多为已存在，直接跳过）。
        self.rebuild_bm25()
        self._vec_checked = False
        self._vec_cache = None
        self.save()

    # ---------- 新增记忆：事件 ----------
    def add_events(self, events: list, source: str = "conversation") -> list:
        """把一批事件（仅摘要+重要度）写入长期记忆"""
        return self.add_events_with_time(events, source=source)

    def add_events_with_time(self, events: list, source: str = "conversation",
                             event_time: str = None) -> list:
        """同 add_events，但可为每条事件写入真实的游戏时间（用于扮演参考）。"""
        ids = []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            summary = (ev.get("summary") or ev.get("event_summary") or "").strip()
            if not summary:
                continue
            self.time_seq += 1
            eid = f"e_{self.next_event_id}"
            self.next_event_id += 1
            self.events[eid] = {
                "event_id": eid,
                "source": source,
                "summary": summary[:500],
                "importance": _clamp_float(ev.get("importance"), 0.5),
                "time_seq": self.time_seq,
                "time": event_time or ev.get("time") or "",
            }
            ids.append(eid)
            self._vec_checked = False
        if not ids:
            raise ValueError("没有有效的事件摘要可写入")

        # 嵌入失败时仍保存事件并建 BM25，_vec_checked 置 False 让下次检索补齐向量。
        embedded = False
        try:
            summaries = [self.events[eid]["summary"] for eid in ids]
            vecs = self._embed().embed_texts(summaries)
            vec = self._vec_cache if self._vec_cache is not None else _load_vectors(self.character_id)
            for eid, v in zip(ids, vecs):
                vec[eid] = v
            self._vec_cache = vec
            _save_vectors(self.character_id, vec)
            embedded = True
        except Exception:  # noqa: BLE001
            embedded = False
        self._vec_checked = embedded
        self.rebuild_bm25()
        self.save()
        return ids

    def add_manual_event(self, summary: str, text: str = "",
                         importance: float = 0.5, source: str = "manual") -> str:
        """手动新增一条记忆：只保存摘要（text 为兼容旧接口的占位，不落盘）。"""
        summary = (summary or "").strip()
        if not summary:
            raise ValueError("记忆摘要不能为空")
        ids = self.add_events(
            [{"summary": summary, "importance": _clamp_float(importance, 0.5)}],
            source=source)
        return ids[0]

    # ---------- 近期记忆 ----------
    def _turn_text(self, turn: dict) -> str:
        """把一条近期记忆（说话人+文本+可选上下文）渲染成一行文本。

        上下文（时间/地点/天气/环境细节）会被拼在开头，使后续总结在丢
        失场景信息的情况下仍能还原当时发生了什么。
        """
        speaker = turn.get("speaker", "")
        text = turn.get("text", "")
        ctx = []
        if turn.get("time"):
            ctx.append(f"时间 {turn['time']}")
        if turn.get("location"):
            ctx.append(f"地点 {turn['location']}")
        if turn.get("weather"):
            ctx.append(f"天气 {turn['weather']}")
        if turn.get("environment"):
            ctx.append(turn["environment"])
        prefix = f"（{'；'.join(ctx)}）" if ctx else ""
        return f"{prefix}[{speaker}] {text}"

    def working_text(self) -> str:
        return "\n".join(self._turn_text(t) for t in self.working_memory)

    def mark_working_memory(self):
        """标记当前全部近期记忆为“已被更新 agent 转成长期记忆”，超容时可先丢弃。"""
        self.working_memory_mark = len(self.working_memory)
        self.save()

    def trim_working_memory(self, limit: int = None) -> dict | None:
        """按标记截断近期记忆（更新后再调用，不立即删除）。

        规则：
          - 标记之前的条目（信息已在更新中形成长期记忆）超容时可直接截断；
          - 一直截断到“标记的那个记忆也没了”仍超容，才回退到总结；
          - 返回 None 表示无需总结；否则返回 {"to_summarize", "kept", "text"}。
        """
        limit = int(limit if limit is not None else CONFIG["WORKING_MEMORY_LIMIT"])
        # 第一步：丢弃标记之前的已覆盖条目
        if self.working_memory_mark > 0:
            drop = min(self.working_memory_mark, len(self.working_memory))
            self.working_memory = self.working_memory[drop:]
            self.working_memory_mark = max(0, self.working_memory_mark - drop)
            self.save()
        if len(self.working_text()) < limit:
            return None
        # 第二步：标记耗尽仍超容，回退到总结
        to_summarize, kept = self.split_working_memory()
        text = "\n".join(self._turn_text(t) for t in to_summarize)
        if to_summarize and len(text) >= CONFIG["MIN_SUMMARIZE_CHARS"]:
            return {"to_summarize": to_summarize, "kept": kept, "text": text}
        return None

    def recent_event_summaries_text(self, limit: int = None) -> str:
        """按时间顺序返回最近若干条长期事件摘要，供角色更新 agent 参考。"""
        limit = int(limit if limit is not None else CONFIG.get("TOP_EVENTS", 8))
        evs = sorted(
            (e for e in self.events.values()),
            key=lambda e: (int(e.get("time_seq", 0)), e.get("event_id", "")),
        )
        evs = evs[-limit:] if limit > 0 else []
        parts = []
        for ev in evs:
            time_text = f"【时间】{ev.get('time')} · " if ev.get("time") else ""
            parts.append(
                f"[事件 {ev.get('event_id')}] 重要度 {float(ev.get('importance', 0.5)):.2f} · "
                f"{time_text}{ev.get('summary', '')}"
            )
        return "\n".join(parts) if parts else "（暂无）"

    def append_working(self, speaker: str, text: str, context: dict = None,
                       turn_seq: int = None):
        # 去重只在“同一回合”内生效：重写/回溯重跑时先按 turn_seq 丢弃旧条目，
        # 因此同名同台词的旧版本会被清理，而不是靠“全局去重”掩盖。跨回合的相似台词不再被误删。
        if turn_seq is not None:
            dup = any(
                t.get("speaker") == speaker and t.get("text") == text
                and t.get("turn_seq") == turn_seq
                for t in self.working_memory
            )
        else:
            # 兼容旧数据：无 turn_seq 时维持原先的全局去重逻辑。
            dup = any(t.get("speaker") == speaker and t.get("text") == text
                      for t in self.working_memory)
        if dup:
            return
        turn = {"speaker": speaker, "text": text}
        if turn_seq is not None:
            turn["turn_seq"] = turn_seq
        if isinstance(context, dict):
            for key in ("time", "location", "weather", "environment"):
                value = context.get(key)
                if value:
                    turn[key] = value
        self.working_memory.append(turn)

    def discard_from_turn(self, target_seq: int):
        """删除某一回合及之后写入的近期记忆（重写/回溯时调用），并立即落盘。

        turn_seq 为 None 的旧条目无法判断归属，保留不动；目标回合起（含）的条目被移除，
        从而保证被拒绝的重写结果不会残留在角色的“近期事件”上下文里。
        """
        if target_seq is None:
            return
        new_wm = [
            t for t in self.working_memory
            if not (isinstance(t.get("turn_seq"), int) and t.get("turn_seq") >= target_seq)
        ]
        if len(new_wm) != len(self.working_memory):
            self.working_memory = new_wm
            self.working_memory_mark = max(
                0, min(self.working_memory_mark, len(self.working_memory)))
            self.save()

    def split_working_memory(self):
        """按比例切分近期记忆：保留最近一段，把旧部分交 LLM 总结。

        ratio 越接近 1，保留的越少、需要总结的越多；默认 0.5 = 前一半总结。
        """
        ratio = float(CONFIG.get("WORKING_SUMMARIZE_RATIO", 0.5))
        ratio = max(0.0, min(1.0, ratio))
        total = len(self.working_text())
        mode = str(CONFIG.get("WORKING_SUMMARY_MODE", "ratio") or "ratio").lower()
        if mode == "hybrid":
            # 混合：保留预算为“最少保留字数”与“(1-ratio) 比例”的较大者。
            keep_budget = max(
                int(CONFIG["WORKING_MEMORY_KEEP_CHARS"]),
                round(total * (1.0 - ratio)),
            )
        else:
            # 纯比例：只按 (1-ratio) 保留，不再额外设下限。
            keep_budget = max(1, round(total * (1.0 - ratio)))
        kept = []
        remaining = keep_budget
        for turn in reversed(self.working_memory):
            size = len(self._turn_text(turn))
            if size <= remaining:
                kept.insert(0, turn)
                remaining -= size
            else:
                break
        if self.working_memory and not kept:
            kept = [self.working_memory[-1]]
        to_summarize = self.working_memory[:len(self.working_memory) - len(kept)]
        return to_summarize, kept

    # ---------- 检索 ----------
    def _ensure_vectors(self):
        """补齐缺失的嵌入向量（快照恢复/旧数据迁移后），只执行一次；随之为文件存储。"""
        if self._vec_checked or not self.events:
            return
        try:
            vec = self._vec_cache if self._vec_cache is not None else _load_vectors(self.character_id)
            missing = [eid for eid in self.events if eid not in vec]
            if missing:
                summaries = [self.events[eid]["summary"] for eid in missing]
                vecs = self._embed().embed_texts(summaries)
                for eid, v in zip(missing, vecs):
                    vec[eid] = v
                _save_vectors(self.character_id, vec)
            self._vec_cache = vec
        except Exception:  # noqa: BLE001  嵌入失败不阻塞检索（回退 BM25）
            self._vec_cache = self._vec_cache if self._vec_cache is not None else _load_vectors(self.character_id)
        self._vec_checked = True

    def search(self, query: str) -> dict:
        """BM25 + 嵌入相似度 + 重要性 + 时效性，返回 Top 事件摘要。

        嵌入（向量）是可选能力：未安装 torch/sentence-transformers、未下载模型，
        或用户在设置里关闭了向量检索时，这里会自动退回**纯 BM25 关键词检索**，
        不再因为缺少可选依赖而让整轮对话失败。
        """
        if not self.events:
            return {"summaries": [], "chunks": []}
        self._ensure_vectors()
        vec_scores = {}
        try:
            qvec = self._embed().embed_one(query)
            vec = self._vec_cache if self._vec_cache is not None else _load_vectors(self.character_id)
            # 向量已用 normalize_embeddings=True 归一化，点积 = 余弦相似度。
            vec_scores = {
                eid: float(np.dot(qvec, v)) for eid, v in vec.items() if eid in self.events
            }
        except Exception:  # noqa: BLE001  嵌入不可用 → 纯 BM25
            vec_scores = {}

        tokens = jieba.lcut(query)
        bm_scores = {}
        bm_data = self._load_bm25()
        bm = bm_data.get("bm25")
        if bm is not None and tokens:
            raw = bm.get_scores(tokens)
            for i, row in enumerate(bm_data.get("rows", [])):
                if raw[i] > 0:
                    bm_scores[row["event_id"]] = float(raw[i])

        candidates = set(vec_scores) | set(bm_scores) | set(self.events)
        vec_n = _norm({eid: vec_scores.get(eid, 0.0) for eid in candidates})
        bm_n = _norm({eid: bm_scores.get(eid, 0.0) for eid in candidates})
        w = read_memory_retrieval()
        if vec_scores:
            rel_raw = {
                eid: (w["embed_weight"] * vec_n.get(eid, 0.0)
                      + w["bm25_weight"] * bm_n.get(eid, 0.0))
                for eid in candidates
            }
            mode = "bm25+embedding"
        else:
            # 没有向量时忽略向量权重，避免「向量权重 0.6」把相关性整体压低。
            rel_raw = {eid: bm_n.get(eid, 0.0) for eid in candidates}
            mode = "bm25"
        rel_n = _norm(rel_raw)

        now = self.time_seq
        imp_raw = {
            eid: float(self.events[eid]["importance"])
            for eid in candidates if eid in self.events
        }
        imp_n = _norm(imp_raw)
        time_raw = {
            eid: 1.0 / (1.0 + CONFIG["TIME_DECAY"] *
                        max(0, now - int(self.events[eid]["time_seq"])))
            for eid in candidates if eid in self.events
        }
        time_n = _norm(time_raw)

        final = {
            eid: (w["relevance_weight"] * rel_n.get(eid, 0.0)
                  + w["importance_weight"] * imp_n.get(eid, 0.0)
                  + w["recency_weight"] * time_n.get(eid, 0.0))
            for eid in candidates
        }
        ranked = sorted(final, key=final.get, reverse=True)
        top = ranked[:CONFIG["TOP_EVENTS"]]

        for eid in top:
            ev = self.events[eid]
            ev["importance"] = min(
                1.0, float(ev["importance"]) + CONFIG["IMPORTANCE_BUMP"])

        summaries = []
        for eid in top:
            ev = self.events[eid]
            summaries.append({
                "event_id": eid,
                "source": ev.get("source", ""),
                "summary": ev["summary"],
                "importance": float(ev["importance"]),
                "time_seq": int(ev["time_seq"]),
                "time": ev.get("time") or "",
                "score": round(float(final[eid]), 4),
            })
        return {"summaries": summaries, "chunks": [], "mode": mode}

    def retrieve(self, query: str) -> list:
        """返回 Top 事件列表（含摘要字段），供多轮检索/规划复用。"""
        return self.search(query).get("summaries", [])

    def get_event(self, event_id: str):
        """按 id 取指定事件（用于多轮检索时强制补充某些事件）。"""
        ev = self.events.get(event_id)
        if not ev:
            return None
        return {
            "event_id": event_id,
            "source": ev.get("source", ""),
            "summary": ev["summary"],
            "importance": float(ev["importance"]),
            "time_seq": int(ev["time_seq"]),
            "time": ev.get("time") or "",
            "score": None,
        }

    def format_memory_context(self, query: str) -> str:
        result = self.search(query)
        parts = []
        used = 0
        max_chars = CONFIG["MAX_CONTEXT_CHARS"]
        for s in result.get("summaries", []):
            time_text = f"【时间】{s.get('time')}\n" if s.get("time") else ""
            block = (
                f"[事件 {s['event_id']}] 重要度 {s['importance']:.2f}\n"
                f"{time_text}事件总结：{s['summary']}"
            )
            if used + len(block) > max_chars:
                break
            parts.append(block)
            used += len(block)
        return "\n\n".join(parts) if parts else "（暂无）"

    def format_events(self, events: list) -> str:
        """把一组事件 dict 拼成文本，供规划/多轮检索使用。"""
        parts = []
        for s in events:
            time_text = f"【时间】{s.get('time')} · " if s.get("time") else ""
            parts.append(
                f"[事件 {s['event_id']}] 重要度 {s.get('importance', 0):.2f} · "
                f"时效 {s.get('time_seq', 0)}\n{time_text}{s.get('summary', '')}")
        return "\n\n".join(parts) if parts else "（暂无）"

    # ---------- BM25 ----------
    def rebuild_bm25(self):
        rows = []
        tokenized = []
        for eid, ev in self.events.items():
            rows.append({
                "event_id": eid,
                "source": ev.get("source", ""),
                "summary": ev.get("summary", ""),
                "importance": float(ev.get("importance", 0.5)),
                "time_seq": int(ev.get("time_seq", 0)),
            })
            tokenized.append(jieba.lcut(ev.get("summary", "")))
        os.makedirs(CONFIG["MEMORY_DIR"], exist_ok=True)
        with open(self.bm25_path, "wb") as f:
            pickle.dump({
                "bm25": BM25Okapi(tokenized) if tokenized else None,
                "rows": rows,
                "tokenized": tokenized,
            }, f)

    def _load_bm25(self) -> dict:
        if os.path.exists(self.bm25_path):
            with open(self.bm25_path, "rb") as f:
                return pickle.load(f)
        self.rebuild_bm25()
        with open(self.bm25_path, "rb") as f:
            return pickle.load(f)

    # ---------- 遗忘 ----------
    def retention(self, ev: dict) -> float:
        age = max(0, self.time_seq - int(ev.get("time_seq", 0)))
        return float(ev.get("importance", 0.5)) / (1.0 + CONFIG["TIME_DECAY"] * age)

    def forget(self) -> bool:
        if len(self.events) <= CONFIG["MAX_MEMORY_EVENTS"]:
            return False
        ranked = sorted(self.events, key=lambda e: self.retention(self.events[e]))
        while len(self.events) > CONFIG["MAX_MEMORY_EVENTS"] and ranked:
            self._delete_event(ranked.pop(0))
        self.rebuild_bm25()
        self.save()
        return True

    def _delete_event(self, eid: str):
        ev = self.events.pop(eid, None)
        if ev is None:
            return
        _delete_vec(self.character_id, eid)
        if self._vec_cache and eid in self._vec_cache:
            del self._vec_cache[eid]

    # ---------- 供 UI 调用的公开增删 ----------
    def delete_event(self, eid: str) -> bool:
        if eid not in self.events:
            return False
        self._delete_event(eid)
        self.rebuild_bm25()
        self.save()
        return True

    def counts(self) -> dict:
        return {
            "character_id": self.character_id,
            "events": len(self.events),
            "working_turns": len(self.working_memory),
            "working_chars": len(self.working_text()),
        }

    def stats(self) -> dict:
        return self.counts()
