"""
世界状态与时间线
=====================
- worldbook.json：只读的世界书原始设定；
- state/world_state.json：世界书的可变副本，由世界更新 Agent 维护；
- state/timeline.json：按时间串联的世界变化；
- state/player_perception.json：玩家当前可观测环境。
"""
import copy
import json
import os
import re
from datetime import timedelta

import card_schema
from settings import CONFIG
from text_utils import render_world_summary
from time_utils import (
    add_minutes, to_iso, parse_iso, is_iso, pretty_time,
    parse_custom_time, format_custom_time, parse_hhmm,
)


def _load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return copy.deepcopy(default)


def _save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _detail_text(d) -> str:
    """把环境信息条目取成纯文本（兼容字符串与 {id, text} 对象）。"""
    if isinstance(d, dict):
        return str(d.get("text") or "").strip()
    return str(d or "").strip()


def _normalize_details(details) -> list:
    """把环境细节统一为 [{id, text}] 列表；旧字符串自动补一个稳定 id。"""
    if not isinstance(details, list):
        return []
    out = []
    used_ids = set()
    max_n = 0
    for d in details:
        if isinstance(d, dict) and str(d.get("id") or "").strip():
            eid = str(d["id"]).strip()
            m = re.match(r"^D(\d+)$", eid)
            if m:
                max_n = max(max_n, int(m.group(1)))
    for d in details:
        if isinstance(d, dict) and str(d.get("id") or "").strip():
            eid = str(d["id"]).strip()
            text = _detail_text(d)
            if eid in used_ids or not text:
                continue
            used_ids.add(eid)
            out.append({"id": eid, "text": text})
        else:
            text = _detail_text(d)
            if not text:
                continue
            max_n += 1
            eid = f"D{max_n}"
            while eid in used_ids:
                max_n += 1
                eid = f"D{max_n}"
            used_ids.add(eid)
            out.append({"id": eid, "text": text})
    # 重排 id，让 D 号保持紧凑连续（D1,D2,...），避免随会话推进无限增长。
    for i, d in enumerate(out, 1):
        d["id"] = f"D{i}"
    return out


def _next_detail_id(details) -> str:
    max_n = 0
    for d in details or []:
        m = re.match(r"^D(\d+)$", str((d or {}).get("id") or "") if isinstance(d, dict) else "")
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"D{max_n + 1}"


def _normalize_tag(tag: str) -> str:
    """把更新 id 归一化：去掉 # / @ 前缀、转大写。"""
    t = str(tag or "").strip().lstrip("#@").upper()
    return t


class WorldState:
    def __init__(self):
        self.worldbook_path = CONFIG["WORLDBOOK_PATH"]
        self.background_path = CONFIG["WORLD_STATE_PATH"]
        self.timeline_path = CONFIG["TIMELINE_PATH"]
        self.perception_path = CONFIG["PLAYER_PERCEPTION_PATH"]

        self.worldbook = _load_json(self.worldbook_path, {"world": "未配置世界书"})
        self.background = _load_json(self.background_path, None)
        if not self.background:
            self.background = copy.deepcopy(self.worldbook)
            self.background["clock"] = CONFIG["START_TIME"]
            if "weather" not in self.background:
                self.background["weather"] = "晴朗"
            self.background["active_events"] = self.background.get("active_events", [])
            self.save_background()

        timeline_raw = _load_json(self.timeline_path, {"events": []})
        self.timeline = timeline_raw.get("events", []) \
            if isinstance(timeline_raw, dict) else []
        self.perception = _load_json(
            self.perception_path,
            {
                "time": self.background.get("clock", CONFIG["START_TIME"]),
                "location": "",
                "weather": self.background.get("weather", "晴朗"),
                "details": [],
            },
        )
        if isinstance(self.perception.get("details"), list):
            self.perception["details"] = _normalize_details(self.perception.get("details"))

    # ---------- 时间 ----------
    def current_time_iso(self) -> str:
        # 以玩家感知时间为准（可能是自定义时间）；没有感知时间才回退内部时钟。
        return self.perception.get("time") or self.background.get("clock") or CONFIG["START_TIME"]

    def world_clock_iso(self) -> str:
        """内部世界时钟（始终为可解析的 ISO），用于推进与更新节点判断。"""
        return self.background.get("clock") or CONFIG["START_TIME"]

    def last_update_time(self) -> str:
        """上一次世界/角色更新的时间（未更新过则用世界开始时间）。"""
        return (self.background.get("last_update_time")
                or self.perception.get("time")
                or self.background.get("clock")
                or CONFIG["START_TIME"])

    def set_last_update_time(self, iso: str):
        if iso:
            self.background["last_update_time"] = iso

    def update_window_text(self) -> str:
        """更新时间段：上一次更新时间 ~ 当前时间（当前）。"""
        return f"{pretty_time(self.last_update_time())} ~ {pretty_time(self.current_time_iso())}（当前）"

    def next_update_time_text(self) -> str:
        """下一次自动更新时间点（配置里的 UPDATE_TIME 中最近未过的那一个），供规划覆盖整段。"""
        times = CONFIG.get("UPDATE_TIME") or []
        if not times:
            return "00:00"
        cur = self.world_clock_iso()
        if not is_iso(cur):
            return "、".join(times)
        now = parse_iso(cur)
        best = None
        for t in times:
            try:
                h, m = parse_hhmm(t)
            except Exception:  # noqa: BLE001
                continue
            cand = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if cand <= now:
                cand += timedelta(days=1)
            if best is None or cand < best:
                best = cand
        if best is None:
            return "、".join(times)
        return f"{best.month}/{best.day} {best.hour}:{best.minute:02d}"

    def advance_default(self) -> str:
        return self._advance_clock()

    def set_time(self, iso: str):
        if iso:
            if is_iso(iso):
                self.background["clock"] = to_iso(parse_iso(iso))
                self.perception["time"] = self.background["clock"]
                self.background["time_has_year"] = True
                self.background["time_has_date"] = True
                self.background["time_prefix"] = ""
            else:
                # 时间“未知 / 模糊”：玩家感知为该文本，世界内部时钟保持不变，避免解析崩溃。
                self.perception["time"] = iso
                base = parse_iso(self.background.get("clock") or CONFIG["START_TIME"])
                parsed = parse_custom_time(iso, base=base)
                if parsed is not None:
                    dt, has_year, has_date, prefix = parsed
                    self.background["clock"] = to_iso(dt)
                    self.background["time_has_year"] = has_year
                    self.background["time_has_date"] = has_date
                    self.background["time_prefix"] = prefix
                    self.perception["time"] = format_custom_time(
                        dt, has_year, has_date, prefix)
                else:
                    # 解析失败：视为未知时间，保留原文显示，但不动内部时钟（不参与推进/比较）。
                    self.background.setdefault("time_has_year", False)
                    self.background.setdefault("time_has_date", False)
                    self.background.setdefault("time_prefix", "")

    def _advance_clock(self) -> str:
        """按“每次推进分钟”推进时间：ISO 推进感知时间本身；自定义时间推进内部时钟，
        并按“是否有年”重新生成显示文本（有年保年，无年隐藏年）。"""
        cur = self.perception.get("time") or ""
        base = self.background.get("clock") or CONFIG["START_TIME"]
        has_year = bool(self.background.get("time_has_year", True))
        has_date = bool(self.background.get("time_has_date", True))
        prefix = str(self.background.get("time_prefix", "") or "")
        new_world = add_minutes(base, CONFIG["DEFAULT_ADVANCE_MINUTES"])
        self.background["clock"] = new_world
        if cur and is_iso(cur):
            self.perception["time"] = new_world
            self.background["time_has_year"] = True
            self.background["time_has_date"] = True
            self.background["time_prefix"] = ""
        elif not cur:
            self.perception["time"] = new_world
        else:
            dt = parse_iso(new_world)
            self.perception["time"] = format_custom_time(
                dt, has_year, has_date, prefix)
            self.background["time_has_year"] = has_year
            self.background["time_has_date"] = has_date
            self.background["time_prefix"] = prefix
        self.save_perception()
        self.save_background()
        return self.current_time_iso()

    # ---------- 世界书副本 ----------
    def world_summary(self, max_chars: int = None,
                      include_background: bool = True) -> str:
        max_chars = max_chars or CONFIG["WORLD_SUMMARY_MAX_CHARS"]
        return render_world_summary(self.background, max_chars=max_chars,
                                    include_background=include_background)

    def world_background(self) -> str:
        """当前会话背景（开场情境），作为世界书的一部分提供给各 Agent。"""
        return str((self.background or {}).get("background") or "").strip()

    def apply_world_changes(self, changes: list):
        """把世界更新 Agent 输出追加到时间线，并更新可变世界状态。"""
        if not changes:
            return
        for change in changes:
            if not isinstance(change, dict):
                continue
            entry = {
                "id": f"w_{len(self.timeline) + 1}",
                "time": change.get("time") or self.current_time_iso(),
                "place": change.get("place", "未知地点"),
                "description": change.get("description", ""),
                "type": change.get("type", "world_event"),
                "affected": change.get("affected", []),
            }
            self.timeline.append(entry)
            if change.get("weather"):
                self.background["weather"] = change["weather"]
                self.perception["weather"] = change["weather"]
            state_updates = change.get("state_updates")
            if isinstance(state_updates, dict):
                self.background.update(state_updates)
        self.save_timeline()
        self.save_background()

    def recent_timeline(self, limit: int = 8) -> list:
        return self.timeline[-limit:] if limit > 0 else []

    # ---------- 环境感知 ----------
    def update_perception(self, environment: dict):
        if not isinstance(environment, dict):
            return
        if environment.get("time"):
            self.set_time(environment["time"])
        for key in ("location", "weather"):
            if environment.get(key):
                self.perception[key] = environment[key]
        if isinstance(environment.get("details"), list):
            self.perception["details"] = _normalize_details(environment["details"])
        self.save_perception()

    def apply_perception(self, perception: dict):
        """手动编辑环境：时间特殊处理（可接受未知/自定义），其余直接写入感知。"""
        if not isinstance(perception, dict):
            return
        if "time" in perception and perception["time"] is not None:
            self.set_time(str(perception["time"] or ""))
        for key in ("weather", "location"):
            if key in perception and perception[key] is not None:
                self.perception[key] = perception[key]
        if "details" in perception and isinstance(perception["details"], list):
            # 手动编辑：保留已有相同文本条目的 id，新增条目分配新 id，删除的条目消失。
            prev = _normalize_details(self.perception.get("details") or [])
            by_text = {}
            for d in prev:
                by_text.setdefault(d["text"], []).append(d["id"])
            merged = []
            used = set()
            for raw in perception["details"]:
                text = _detail_text(raw)
                if not text:
                    continue
                if text in by_text and by_text[text]:
                    eid = by_text[text].pop(0)
                else:
                    eid = _next_detail_id(merged)
                if eid in used:
                    continue
                used.add(eid)
                merged.append({"id": eid, "text": text})
            self.perception["details"] = merged
        if "scene_characters" in perception and isinstance(perception["scene_characters"], list):
            norm = []
            seen = set()
            for item in perception["scene_characters"]:
                if isinstance(item, dict):
                    name = str(item.get("character") or item.get("name") or "").strip()
                    isolated = bool(item.get("isolated"))
                else:
                    name = str(item).strip()
                    isolated = False
                if name and name not in seen:
                    seen.add(name)
                    norm.append({"name": name, "isolated": isolated})
            self.perception["scene_characters"] = norm
        self.save_perception()
        self.save_background()

    def advance_time(self) -> str:
        """手动推进世界时间（用于自定义/未知时间的世界）。使用内部时钟推进。"""
        return self._advance_clock()

    def current_environment_text(self) -> str:
        """合并后的当前环境：时间/天气/细节 + 以世界书为准的地点名（不含地点说明）。

        地点说明不注入 prompt，由前端在环境面板点击地点后以气泡展示。
        """
        perception = self.perception or {}
        details = [_detail_text(d) for d in (perception.get("details") or [])]
        location = perception.get("location") or "未知"
        # 命中世界书地点树时，以命中路径作为规范地点名（更准确地反映世界设定）。
        locs = card_schema.world_locations(self.background)
        found = card_schema.find_location_path(locs, location)
        if found and found.get("path"):
            location = " › ".join(found["path"])
        lines = []
        scene_chars = perception.get("scene_characters") or []
        if isinstance(scene_chars, list) and scene_chars:
            names = []
            for item in scene_chars:
                if isinstance(item, dict):
                    names.append(str(item.get("name") or ""))
                elif isinstance(item, str):
                    names.append(item)
            names = [n for n in names if n]
            if names:
                lines.append(f"场景角色：{'、'.join(names)}")
        lines += [
            f"时间：{pretty_time(perception.get('time', ''))}",
            f"地点：{location}",
            f"天气：{perception.get('weather', '')}",
        ]
        if details:
            lines.append("其他信息：")
            lines.extend(f"- {d}" for d in details)
        return "\n".join(lines)

    def tagged_environment_text(self) -> str:
        """带稳定标记的环境文本，专供可观测环境 Agent 做“稀疏更新”使用。

        每条信息以 #T/#L/#W/#S/#D1... 标记；Agent 只需输出发生变化的条目。
        """
        perception = self.perception or {}
        details = _normalize_details(perception.get("details") or [])
        location = perception.get("location") or "未知"
        locs = card_schema.world_locations(self.background)
        found = card_schema.find_location_path(locs, location)
        if found and found.get("path"):
            location = " › ".join(found["path"])
        lines = [f"#T 时间：{pretty_time(perception.get('time', ''))}",
                 f"#L 地点：{location}",
                 f"#W 天气：{perception.get('weather', '')}"]
        scene_chars = perception.get("scene_characters") or []
        names = []
        if isinstance(scene_chars, list):
            for item in scene_chars:
                if isinstance(item, dict):
                    names.append(str(item.get("name") or ""))
                elif isinstance(item, str):
                    names.append(item)
        names = [n for n in names if n]
        if names:
            lines.append(f"#S 场景角色：{'、'.join(names)}")
        for d in details:
            lines.append(f"#{d['id']} 其他信息：{d['text']}")
        return "\n".join(lines)

    def apply_environment_updates(self, items: list, scene_characters=None) -> list:
        """应用可观测环境 Agent 的稀疏更新。

        items: [{"id": "#W"|"#T"|"#L"|"#S"|"#D1"..., "value": "新内容"|null}]
        value 为 null 表示删除该条目（仅对 #D 有效）。
        只修改发生变化的条目；未给出的条目保持不变；新增条目用新 id。
        返回被修改的感知字段名列表（用于前端 NEW! 角标）。
        """
        changed = []
        if not isinstance(items, list):
            items = []
        details = _normalize_details(self.perception.get("details") or [])
        detail_idx = {d["id"]: i for i, d in enumerate(details)}
        time_updated = False
        for upd in items:
            if not isinstance(upd, dict):
                continue
            tag = _normalize_tag(upd.get("id") or "")
            value = upd.get("value")
            if tag == "T":
                new_time = str(value or "").strip() if value is not None else ""
                # 模型只要给出 #T，就视为“由它指定时间”，不再额外自然推进。
                time_updated = True
                if new_time and new_time != str(self.perception.get("time") or ""):
                    self.set_time(new_time)
                    changed.append("time")
            elif tag == "L":
                new_loc = str(value or "").strip() if value is not None else ""
                if new_loc and new_loc != str(self.perception.get("location") or ""):
                    self.perception["location"] = new_loc
                    changed.append("location")
            elif tag == "W":
                new_weather = str(value or "").strip() if value is not None else ""
                if new_weather and new_weather != str(self.perception.get("weather") or ""):
                    self.perception["weather"] = new_weather
                    changed.append("weather")
            elif tag == "S" and scene_characters is None and value is not None:
                # 正常情况下场景角色通过 environment.scene_characters 单独传入；
                # 若模型把场景变化也写进 #S，也兼容处理。
                norm = []
                for item in value if isinstance(value, list) else []:
                    if isinstance(item, str):
                        norm.append({"name": item.strip(), "isolated": False})
                    elif isinstance(item, dict):
                        norm.append({
                            "name": str(item.get("character") or item.get("name") or "").strip(),
                            "isolated": bool(item.get("isolated")),
                        })
                if norm:
                    self.perception["scene_characters"] = norm
                    changed.append("scene_characters")
            elif tag.startswith("D"):
                detail_id = tag
                text = _detail_text(value) if value is not None else ""
                if detail_id in detail_idx:
                    i = detail_idx[detail_id]
                    if not text:
                        # 删除该条目
                        details.pop(i)
                        # 重算后续索引
                        detail_idx = {d["id"]: i for i, d in enumerate(details)}
                    elif text != details[i]["text"]:
                        details[i]["text"] = text
                    changed.append("details")
                elif text:
                    # 新增条目
                    details.append({"id": detail_id, "text": text})
                    detail_idx[detail_id] = len(details) - 1
                    changed.append("details")
        self.perception["details"] = details
        if not time_updated:
            # 未给出时间时，按默认节奏自然推进。
            self.advance_default()
        self.save_perception()
        self.save_background()
        # 去重并保持顺序
        seen = set()
        out = []
        for k in changed:
            if k not in seen:
                seen.add(k)
                out.append(k)
        return out

    def location_context_text(self) -> str:
        """世界书全部地点：各级地点名 + 仅一级地点的简介（供更新 Agent）。"""
        lines = []

        def walk(nodes, depth):
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                name = (node.get("name") or "").strip()
                if not name:
                    continue
                desc = (node.get("description") or "").strip()
                indent = "  " * depth
                if depth == 0 and desc:
                    lines.append(f"{indent}- {name}：{desc}")
                else:
                    lines.append(f"{indent}- {name}")
                walk(node.get("children") or [], depth + 1)

        walk(card_schema.world_locations(self.background), 0)
        return "\n".join(lines)

    # ---------- 持久化 ----------
    def save_background(self):
        _save_json(self.background_path, self.background)

    def save_timeline(self):
        _save_json(self.timeline_path, {"events": self.timeline})

    def save_perception(self):
        if isinstance(self.perception.get("details"), list):
            self.perception["details"] = _normalize_details(self.perception.get("details"))
        _save_json(self.perception_path, self.perception)

    def save(self):
        self.save_background()
        self.save_timeline()
        self.save_perception()
