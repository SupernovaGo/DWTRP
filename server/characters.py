"""
角色卡与动态状态存储
==========================
- 核心角色：data/core_characters/*.json，一个文件一个角色；
- 动态状态：state/character_states/<id>.json，与角色卡分离。
"""
import copy
import json
import os
import re

import card_schema
from settings import CONFIG
from text_utils import render_character_card, render_compact_summary


def _load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return copy.deepcopy(default)


def _save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def deep_merge(base: dict, patch: dict) -> dict:
    """递归合并任意字段；list 直接覆盖，dict 继续合并。"""
    result = copy.deepcopy(base)
    for key, value in (patch or {}).items():
        if value in (None, "", [], {}):
            continue
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def slugify(name: str) -> str:
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", (name or "").strip())
    return slug or "character"


def _levenshtein(a: str, b: str, max_d: int = 2) -> int:
    if a == b:
        return 0
    if abs(len(a) - len(b)) > max_d:
        return max_d + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        if min(cur) > max_d:
            return max_d + 1
        prev = cur
    return prev[-1]


class CharacterStore:
    def __init__(self):
        self.core_dir = CONFIG["CORE_CHARACTERS_DIR"]
        self.general_path = CONFIG["GENERAL_CHARACTERS_PATH"]
        self.states_dir = CONFIG["CHARACTER_STATES_DIR"]
        self.user_identity = _load_json(
            CONFIG["USER_IDENTITY_PATH"],
            {"name": "老师", "role": "玩家"},
        )

        self.characters = {}
        self._load_general()
        self._load_core()

    # ---------- 加载 ----------
    def _load_general(self):
        data = _load_json(self.general_path, {"characters": []})
        for entry in data.get("characters", []):
            if not isinstance(entry, dict):
                continue
            entry = copy.deepcopy(entry)
            cid = entry.get("id") or slugify(entry.get("name", ""))
            entry["id"] = cid
            entry.setdefault("name", cid)
            self.characters[cid] = {
                "card": entry,
                "state": self._load_state(cid),
                "is_core": False,
                "path": None,
            }

    def _load_core(self):
        if not os.path.isdir(self.core_dir):
            return
        for filename in sorted(os.listdir(self.core_dir)):
            if not filename.lower().endswith(".json"):
                continue
            path = os.path.join(self.core_dir, filename)
            try:
                card = _load_json(path, {})
            except json.JSONDecodeError:
                continue
            if not isinstance(card, dict):
                continue
            card = copy.deepcopy(card)
            cid = card.get("id") or slugify(card.get("name") or filename[:-5])
            card["id"] = cid
            card.setdefault("name", cid)
            self.characters[cid] = {
                "card": card,
                "state": self._load_state(cid),
                "is_core": card_schema.is_core(card),
                "path": path,
            }

    def _load_state(self, cid: str) -> dict:
        path = os.path.join(self.states_dir, f"{cid}.json")
        return _load_json(path, {
            "position": "",
            "mood": "",
            "doing": "",
            "appearance": {"clothes": "", "description": ""},
            "plan": {},
            "last_updated": "",
        })

    # ---------- 查询 ----------
    def all_ids(self):
        return list(self.characters.keys())

    def core_ids(self):
        return [cid for cid, c in self.characters.items() if c["is_core"]]

    def general_ids(self):
        return [cid for cid, c in self.characters.items() if not c["is_core"]]

    def get(self, cid: str):
        return self.characters.get(cid)

    def card(self, cid: str) -> dict:
        rec = self.get(cid)
        return rec["card"] if rec else {}

    def state(self, cid: str) -> dict:
        rec = self.get(cid)
        return rec["state"] if rec else {}

    def display_name(self, cid: str) -> str:
        rec = self.get(cid)
        if not rec:
            return cid
        return card_schema.display_name(rec["card"]) or cid

    def full_display_name(self, cid: str) -> str:
        rec = self.get(cid)
        if not rec:
            return cid
        return card_schema.full_display_name(rec["card"]) or cid

    def resolve(self, ref: str) -> str | None:
        """把模型给出的角色引用解析为角色 id：兼容 id、显示名、别名、名称子串与后辍拼写。"""
        if not ref:
            return None
        ref = str(ref).strip()
        if ref in self.characters:
            return ref
        ref_lower = ref.lower()
        for key in self.characters:
            if key.lower() == ref_lower:
                return key
        # 按显示名精确匹配
        for key, rec in self.characters.items():
            if (rec["card"].get("name") or "").strip() == ref:
                return key
            if card_schema.display_name(rec["card"]) == ref:
                return key
            if card_schema.full_name(rec["card"]) == ref:
                return key
            # 英文名：id / english_name / 别名（不区分大小写）
            for eng in (rec["card"].get("english_name"), rec["card"].get("id")):
                if eng and str(eng).strip().lower() == ref_lower:
                    return key
            aliases = card_schema.aliases(rec["card"])
            if any(a.lower() == ref_lower for a in aliases):
                return key
        # 名称包含匹配（模型可能输出“砂狼”而非“砂狼白子”）
        for key, rec in self.characters.items():
            name = (rec["card"].get("name") or "").strip()
            if name and (name in ref or ref in name):
                return key
            for part in (card_schema.display_name(rec["card"]), card_schema.full_name(rec["card"])):
                if part and (part in ref or ref in part):
                    return key
        # 英文名/别名近似匹配（容忍 1~2 个字符差异，如 yuka -> yuuka）
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9_ -]{1,30}", ref):
            for key, rec in self.characters.items():
                cands = [rec["card"].get("english_name"), rec["card"].get("id")]
                cands += card_schema.aliases(rec["card"])
                for cand in cands:
                    c = str(cand).strip().lower() if cand else ""
                    rl = ref_lower
                    if c and (c == rl or _levenshtein(c, rl, 2) <= 2 or c.startswith(rl) or rl.startswith(c)):
                        return key
        return None

    # ---------- 渲染 ----------
    def render_card(self, cid: str, max_chars: int = None) -> str:
        rec = self.get(cid)
        if not rec:
            return f"（未知角色：{cid}）"
        return render_character_card(rec["card"], max_chars=max_chars)

    def render_compact_summary(self, cid: str) -> str:
        """精简角色摘要：只输出名字/简介/性格，用于初始化与玩家 Agent。"""
        rec = self.get(cid)
        if not rec:
            return ""
        return render_compact_summary(rec["card"])

    def render_compact_plan(self, cid: str) -> str:
        """仅渲染角色规划（时间-地点-干什么），不包含心情/正在做什么/位置等当前状态。"""
        rec = self.get(cid)
        if not rec:
            return ""
        st = rec["state"] or {}
        plans = card_schema.normalize_plan(st.get("plan") or st.get("current_plan"))
        if not plans:
            return ""
        return "规划：\n" + card_schema.render_plan_text(plans)

    def relationship_affection(self, cid_a: str, cid_b: str) -> float:
        """返回两个角色之间（A→B 或 B→A 任一条）的最佳好感度；无关系返回 0。"""
        rec_a = self.get(cid_a)
        rec_b = self.get(cid_b)
        if not rec_a or not rec_b:
            return 0.0
        best = 0.0
        for rel in card_schema.normalize_relationships(rec_a["card"]):
            target = rel.get("target") or ""
            aff = rel.get("affection")
            if target and self.resolve(target) == cid_b and aff is not None:
                try:
                    best = max(best, float(aff))
                except (TypeError, ValueError):
                    pass
        for rel in card_schema.normalize_relationships(rec_b["card"]):
            target = rel.get("target") or ""
            aff = rel.get("affection")
            if target and self.resolve(target) == cid_a and aff is not None:
                try:
                    best = max(best, float(aff))
                except (TypeError, ValueError):
                    pass
        return best

    # ---------- 关系网 ----------
    def relationships(self, cid: str) -> list:
        rec = self.get(cid)
        if not rec:
            return []
        return card_schema.normalize_relationships(rec["card"])

    def set_relationships(self, cid: str, relationships: list):
        """把归一化后的关系网写回角色卡（保留其他字段）。"""
        rec = self.get(cid)
        if not rec:
            return
        card = rec["card"]
        card["relationships"] = relationships
        self.save_core(cid)

    def add_relationship(self, cid: str, rel: dict, mirror=True) -> bool:
        """为角色增加一条关系。若目标在其他会话角色中且非单向，则镜像一条反向关系。
        rel: {target, address, relation, detail, affection, directed}
        返回是否发生新增。
        """
        rec = self.get(cid)
        if not rec:
            return False
        target = str(rel.get("target") or "").strip()
        if not target or target == card_schema.display_name(rec["card"]):
            return False
        current = card_schema.relationships_by_target(rec["card"])
        if target in current:
            return False
        standardized = {
            "target": target,
            "address": str(rel.get("address") or "").strip(),
            "relation": str(rel.get("relation") or "").strip(),
            "detail": str(rel.get("detail") or "").strip(),
            "affection": rel.get("affection"),
            "directed": bool(rel.get("directed", False)),
        }
        new_list = card_schema.normalize_relationships(rec["card"]) + [standardized]
        self.set_relationships(cid, new_list)

        # 镜像：目标角色也是本会话角色且关系非单向
        if mirror and not standardized["directed"]:
            target_cid = self.resolve(target)
            if target_cid and target_cid != cid:
                tRec = self.get(target_cid)
                if tRec:
                    t_current = card_schema.relationships_by_target(tRec["card"])
                    my_name = card_schema.display_name(rec["card"])
                    if my_name not in t_current:
                        self.add_relationship(target_cid, {
                            "target": my_name,
                            "address": standardized.get("address", ""),
                            "relation": standardized.get("relation", ""),
                            "detail": (f"（由“{my_name}”的关系网补充）：对方对{target}的认识如下——"
                                       + (standardized.get("detail", "") or "")),
                            "affection": standardized.get("affection"),
                            "directed": True,
                        }, mirror=False)
        self.save()
        return True

    def render_all_summaries(self, core_only: bool = False) -> str:
        """精简的全部角色摘要（名字/简介/性格），供玩家 Agent 与开场初始化使用。"""
        lines = []
        for cid in self.all_ids():
            if core_only and not self.get(cid)["is_core"]:
                continue
            ctype = "核心角色" if self.get(cid)["is_core"] else "普通角色"
            name = self.display_name(cid)
            body = self.render_compact_summary(cid)
            plan = self.render_compact_plan(cid)
            if plan:
                body += f"\n{plan}"
            lines.append(f"### {ctype}：{name}\n{body}")
        return "\n\n".join(lines) if lines else "（暂无）"

    # ---------- 玩家 Agent 相关角色筛选 ----------
    @staticmethod
    def _place_path(place) -> list:
        """把地点拆成层级片段（> / › / - / / 等分隔）。"""
        import re
        segs = re.split(r"[>›·\-/／、，,\s]+", str(place or ""))
        return [s.strip() for s in segs if s.strip()]

    @classmethod
    def _place_overlap(cls, a: str, b: str) -> bool:
        """判断两个地点是否“可能偶遇”：前缀相同，且子地点不互斥。

        一方是另一方的祖先（或相等）即视为不互斥；若同一前缀下的二级地点不同则排除。
        """
        if not a or not b:
            return False
        pa, pb = cls._place_path(a), cls._place_path(b)
        if not pa or not pb or pa[0] != pb[0]:
            return False
        return pa[:len(pb)] == pb or pb[:len(pa)] == pa

    def plan_related_to_player(self, cid: str) -> bool:
        """该角色是否有一条规划标记为「与主角相关」。"""
        st = self.state(cid) or {}
        plans = card_schema.normalize_plan(st.get("current_plan") or st.get("plan"))
        return any(bool(p.get("related")) for p in plans)

    def _char_current_place(self, cid: str) -> str:
        st = self.state(cid) or {}
        plans = card_schema.normalize_plan(st.get("current_plan") or st.get("plan"))
        for p in plans:
            if p.get("place"):
                return p["place"]
        return str(st.get("position") or "")

    def _name_in_text(self, cid: str, text: str) -> bool:
        rec = self.get(cid)
        if not rec or not text:
            return False
        card = rec["card"]
        cands = [
            card_schema.full_display_name(card),
            card_schema.display_name(card),
            card_schema.full_name(card),
            card.get("name"),
            card.get("surname"),
            card.get("id"),
            card.get("english_name"),
        ]
        cands += card_schema.aliases(card)
        for c in cands:
            c = str(c or "").strip()
            if c and len(c) >= 2 and c in text:
                return True
        return False

    def _player_relevant_cids(self, player_location: str = "", player_input: str = ""):
        """把“可能与玩家交互”的角色分成三类，返回 (nearby, plan_interact, active) 的 id 列表。"""
        nearby, plan_interact, active = [], [], []
        for cid in self.all_ids():
            if not self.get(cid):
                continue
            if self._name_in_text(cid, player_input):
                active.append(cid)
            elif self.plan_related_to_player(cid):
                plan_interact.append(cid)
            elif self._place_overlap(self._char_current_place(cid), player_location):
                nearby.append(cid)
        return nearby, plan_interact, active

    def render_player_relevant_summaries(self, player_location: str = "",
                                         player_input: str = "", detail: str = "full") -> str:
        """玩家 Agent 摘要：把“可能与玩家交互”的角色分成三类。

        - 处在临近位置的角色：地点可能偶遇；
        - 规划与玩家交互的角色：某段规划 related_to_player；
        - 玩家可能主动交互的角色：玩家输入提到其名字。

        detail=full：三类都给全（简介/性格 + 全部规划）；
        detail=brief：临近的只给名字，规划交集的给名字+相关规划，主动交互的给名字+全部规划。
        """
        nearby, plan_interact, active = self._player_relevant_cids(player_location, player_input)

        full = str(detail or "").strip().lower() not in ("less", "brief", "0", "false", "no")
        blocks = []
        if nearby:
            blocks.append(self._render_char_group(
                "处在临近位置的角色", nearby, "nearby", full, player_location))
        if plan_interact:
            blocks.append(self._render_char_group(
                "规划与玩家交互的角色", plan_interact, "plan", full, player_location))
        if active:
            blocks.append(self._render_char_group(
                "玩家可能主动交互的角色", active, "active", full, player_location))
        return "\n\n".join(b for b in blocks if b) or "（暂无）"

    def _render_char_group(self, title: str, cids: list, kind: str, full: bool,
                           player_location: str) -> str:
        lines = [f"### {title}"]
        for cid in cids:
            name = self.display_name(cid)
            if full:
                body = self.render_compact_summary(cid).strip()
                plans = self._format_plan_block(cid, None, player_location)
                lines.append(body + ("\n" + plans if plans else ""))
            elif kind == "nearby":
                lines.append(f"- {name}")
            elif kind == "plan":
                plans = self._format_plan_block(cid, "related", player_location)
                lines.append(f"- {name}" + ("\n  " + plans if plans else ""))
            else:  # active
                plans = self._format_plan_block(cid, None, player_location)
                lines.append(f"- {name}" + ("\n  " + plans if plans else ""))
        return "\n".join(lines)

    def _format_plan_block(self, cid: str, mode, player_location: str) -> str:
        st = self.state(cid) or {}
        plans = card_schema.normalize_plan(st.get("current_plan") or st.get("plan"))
        if mode == "related":
            show = [p for p in plans if p.get("related")]
        else:
            show = plans
        segs = []
        for p in show:
            if not (p.get("time") or p.get("place") or p.get("action")):
                continue
            segs.append(f"{p.get('time', '') or ''} 在 {p.get('place', '') or '？'}："
                        f"{p.get('action', '') or ''}")
        return "规划：" + "；".join(segs) if segs else ""

    # ---------- 更新 ----------
    def update_state(self, cid: str, patch: dict):
        rec = self.get(cid)
        if not rec:
            return
        rec["state"] = deep_merge(rec["state"], card_schema.normalize_state_patch(patch))
        self.save_state(cid)

    def update_card(self, cid: str, patch: dict):
        """根据文件实际字段动态合并角色卡，不写死字段。"""
        rec = self.get(cid)
        if not rec:
            return
        rec["card"] = deep_merge(rec["card"], patch)
        if rec.get("path"):
            _save_json(rec["path"], rec["card"])
        else:
            self.save_general()

    def promote_to_core(self, cid: str, extra_fields: dict = None) -> bool:
        """把普通角色升级为核心角色，并补齐一个核心角色通常需要的空字段。"""
        rec = self.get(cid)
        if not rec or rec["is_core"]:
            return False
        card = copy.deepcopy(rec["card"])
        card = deep_merge(card, extra_fields or {})
        for key in ("intro", "personality", "appearance"):
            card.setdefault(key, "")
        card.setdefault("relationships", [])
        card.setdefault("speech_style", {"description": "", "examples": []})
        card["id"] = cid
        path = os.path.join(self.core_dir, f"{cid}.json")
        _save_json(path, card)
        rec["card"] = card
        rec["is_core"] = True
        rec["path"] = path
        self.save_general()
        return True

    def add_from_library(self, card: dict) -> str:
        """把资源库角色卡复制进当前会话，并立即纳入运行时角色集合。"""
        if not isinstance(card, dict):
            raise ValueError("角色卡不是有效对象")
        cid = (card.get("id") or slugify(card.get("name", "") or "")).strip()
        if not cid:
            raise ValueError("角色卡缺少 id")
        if cid in self.characters:
            return cid
        entry = copy.deepcopy(card)
        entry["id"] = cid
        entry.setdefault("name", cid)
        entry.setdefault("is_core", card_schema.is_core(entry))
        entry.setdefault("tags", [])
        path = os.path.join(self.core_dir, f"{cid}.json")
        _save_json(path, entry)
        self.characters[cid] = {
            "card": entry,
            "state": self._load_state(cid),
            "is_core": card_schema.is_core(entry),
            "path": path,
        }
        return cid

    def remove(self, cid: str) -> bool:
        """从会话移除角色（含角色卡与动态状态文件）。"""
        rec = self.characters.pop(cid, None)
        if not rec:
            return False
        path = rec.get("path") or os.path.join(self.core_dir, f"{cid}.json")
        if path and os.path.exists(path):
            os.remove(path)
        spath = os.path.join(self.states_dir, f"{cid}.json")
        if os.path.exists(spath):
            os.remove(spath)
        return True

    def save_state(self, cid: str):
        rec = self.get(cid)
        if not rec:
            return
        _save_json(os.path.join(self.states_dir, f"{cid}.json"), rec["state"])

    def save_core(self, cid: str):
        rec = self.get(cid)
        if rec and rec["is_core"] and rec.get("path"):
            _save_json(rec["path"], rec["card"])

    def save_general(self):
        general = [
            self.characters[cid]["card"]
            for cid in self.general_ids()
            if not self.characters[cid].get("path")
        ]
        _save_json(self.general_path, {"characters": general})

    def save(self):
        for cid in self.all_ids():
            self.save_state(cid)
            rec = self.characters[cid]
            if rec.get("path"):
                _save_json(rec["path"], rec["card"])
        self.save_general()
