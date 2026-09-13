"""
角色卡 / 世界书标准 schema
================================
"""

# 角色卡“元字段”：不进入扮演模型
CARD_META_KEYS = {"id", "tags", "is_core", "avatar"}


def _present(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return True


def get_field(data: dict, key: str, default=None):
    """按标准英文键读取字段。"""
    if isinstance(data, dict):
        v = data.get(key)
        if _present(v):
            return v
    return default


def get_bool(data: dict, key: str, default=False) -> bool:
    val = get_field(data, key, default)
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() in ("true", "1", "yes", "是")
    return bool(val)


def display_name(card: dict) -> str:
    if not isinstance(card, dict):
        return ""
    return str(card.get("name") or card.get("id") or "")


def full_name(card: dict) -> str:
    s = get_field(card, "surname", "")
    n = display_name(card)
    return f"{s}{n}" if s else n


def full_display_name(card: dict) -> str:
    """用于界面显示的“姓 名”（姓和名之间加空格）。无姓时仅返回名。"""
    s = get_field(card, "surname", "")
    n = display_name(card)
    if not s:
        return n
    return f"{s} {n}".strip()


def for_model(card: dict) -> dict:
    if not isinstance(card, dict):
        return {}
    return {k: v for k, v in card.items() if k not in CARD_META_KEYS}


def is_core(card: dict) -> bool:
    return get_bool(card, "is_core", False)


def aliases(card: dict) -> list:
    vals = get_field(card, "aliases", [])
    return [str(a).strip() for a in vals if str(a).strip()] if isinstance(vals, list) else []


# ---------- 头像（裸 base64 -> data URL） ----------
def normalize_avatar(value) -> str:
    """把角色头像字段规范为可直接用于 <img> 的 data URL。
    兼容裸 base64（WebP/JPEG/PNG/GIF）与已是 data: 前缀的输入。
    """
    if not isinstance(value, str):
        return ""
    s = value.strip()
    if not s:
        return ""
    if s.startswith("data:"):
        return s
    if s.startswith("http://") or s.startswith("https://"):
        return s
    # 按 base64 魔数推断 MIME（WebP: RIFF....WEBP -> UklGR）
    mime = "image/webp"
    if s.startswith("/9j"):
        mime = "image/jpeg"
    elif s.startswith("iVBOR"):
        mime = "image/png"
    elif s.startswith("R0lGOD"):
        mime = "image/gif"
    elif not s.startswith("UklGR"):
        # 非已知魔数，仍按 webp 尝试
        mime = "image/webp"
    return f"data:{mime};base64,{s}"


def normalize_card_avatar(card: dict) -> dict:
    """返回 avatar 已规范化的角色卡副本（不修改原对象）。"""
    if not isinstance(card, dict):
        return card
    out = dict(card)
    if "avatar" in out:
        out["avatar"] = normalize_avatar(out["avatar"])
    return out


# ---------- 关系网 ----------
def normalize_relationships(card: dict) -> list:
    """关系网统一为：
    [{target, address, relation, detail, affection, directed}]
    只读取标准 relationships 字段。
    """
    rels = get_field(card, "relationships", [])
    if not isinstance(rels, list):
        return []
    out = []
    for raw in rels:
        if not isinstance(raw, dict):
            continue
        target = str(raw.get("target") or "").strip()
        if not target:
            continue
        affection = raw.get("affection", "")
        try:
            affection = float(affection)
        except (TypeError, ValueError):
            affection = None
        out.append({
            "target": target,
            "address": str(raw.get("address") or "").strip(),
            "relation": str(raw.get("relation") or "").strip(),
            "detail": str(raw.get("detail") or "").strip(),
            "affection": affection,
            "directed": bool(raw.get("directed", False)),
        })
    return out


def relationships_by_target(card: dict) -> dict:
    result = {}
    for rel in normalize_relationships(card):
        result[rel["target"]] = rel
    return result


# ---------- 说话风格 ----------
def speech_style_text(card: dict) -> str:
    style = get_field(card, "speech_style")
    if isinstance(style, dict):
        desc = str(style.get("description") or "")
        examples = style.get("examples") or []
        parts = []
        if desc:
            parts.append(f"描述：{desc}")
        if isinstance(examples, list) and examples:
            ex = "\n".join(f"- “{e}”" for e in examples if str(e).strip())
            if ex:
                parts.append(f"示例：\n{ex}")
        return "\n".join(parts)
    if isinstance(style, str):
        return style
    return ""


# ---------- 动态状态（会话内） ----------
def _rel_bool(value) -> bool:
    """把 related_to_player / related 字段归一化为布尔。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "y", "是", "相关")
    return False


def normalize_plan_item(item: dict) -> dict:
    """把一条规划统一为 {time, place, action, related}。"""
    if not isinstance(item, dict):
        return {"time": "", "place": "", "action": "", "related": False}
    return {
        "time": str(item.get("time") or item.get("time_period") or "").strip(),
        "place": str(item.get("place") or item.get("location") or "").strip(),
        "action": str(item.get("action") or "").strip(),
        "related": _rel_bool(item.get("related_to_player", item.get("related", False))),
    }


def normalize_plan(plan) -> list:
    """把规划统一为 [{time, place, action} ...] 列表。

    兼容旧的单条 dict（{"time"/"time_period","place"/"location","action"}）、
    字符串（视为 action），以及已使用列表的新格式。
    """
    if plan is None:
        return []
    if isinstance(plan, dict):
        item = normalize_plan_item(plan)
        return [item] if (item["time"] or item["place"] or item["action"]) else []
    if isinstance(plan, list):
        out = []
        for item in plan:
            if item is None:
                continue
            if isinstance(item, dict):
                norm = normalize_plan_item(item)
                if norm["time"] or norm["place"] or norm["action"]:
                    out.append(norm)
            elif isinstance(item, str) and str(item).strip():
                out.append({"time": "", "place": "", "action": str(item).strip(),
                            "related": False})
        return out
    if isinstance(plan, str) and plan.strip():
        return [{"time": "", "place": "", "action": plan.strip(), "related": False}]
    return []


def render_plan_text(plan) -> str:
    """把规划渲染为「时间 在 地点：做什么」的文本；多条规划按行列出。"""
    plans = normalize_plan(plan)
    if not plans:
        return "（暂无）"
    lines = []
    multi = len(plans) > 1
    for i, p in enumerate(plans, 1):
        seg = p.get("time") or ""
        place = p.get("place") or ""
        action = p.get("action") or ""
        body = f"{seg or ''} 在 {place or '？'}：{action or '（无描述）'}"
        lines.append(f"{i}. {body}" if multi else body)
    return "\n".join(lines)


def normalize_state_patch(patch: dict) -> dict:
    """把模型/前端传来的状态修改统一成标准英文键（兼容 location/current_plan 等运行时返回）。"""
    if not isinstance(patch, dict):
        return patch or {}
    out = {}
    if patch.get("position") or patch.get("location"):
        out["position"] = patch.get("position", patch.get("location"))
    if patch.get("mood") is not None:
        out["mood"] = patch["mood"]
    if patch.get("doing") is not None:
        out["doing"] = patch["doing"]
    if patch.get("appearance") is not None:
        out["appearance"] = patch["appearance"]
    if patch.get("plan") is not None or patch.get("current_plan") is not None:
        # 存为列表，保证后续所有消费方都按“多条规划”处理。
        out["plan"] = normalize_plan(patch.get("plan", patch.get("current_plan")))
    if patch.get("last_updated") is not None:
        out["last_updated"] = patch["last_updated"]
    return out


# ---------- 世界书 ----------
def wb_name(data: dict) -> str:
    return str((data or {}).get("name") or (data or {}).get("world") or "未命名世界")


def wb_overview(data: dict) -> str:
    return str((data or {}).get("overview") or "")


def world_entries(data: dict) -> list:
    """世界书词条（设定）。仅读取标准 entries 字段。
    [{key, name, keywords[], importance(0~1), info}]
    """
    entries = (data or {}).get("entries") or []
    if not isinstance(entries, list):
        return []
    result = []
    for idx, raw in enumerate(entries):
        if not isinstance(raw, dict):
            continue
        kws = raw.get("keywords") or []
        if isinstance(kws, str):
            kws = [kws]
        kws = [str(k).strip() for k in kws if str(k).strip()]
        importance = raw.get("importance", 50)
        try:
            imp = max(0.0, min(1.0, float(importance) / 100.0))
        except (TypeError, ValueError):
            imp = 0.5
        name = str(raw.get("name") or (kws[0] if kws else f"Entry {idx + 1}"))
        info = str(raw.get("info") or raw.get("description") or "")
        result.append({
            "key": f"entry_{idx}",
            "name": name,
            "keywords": kws or [name],
            "importance": imp,
            "info": info or name,
        })
    return result


def world_locations(data: dict) -> list:
    """世界书地点树（最多三级）：[{name, description, children[]}]。仅读取 locations。"""
    locs = (data or {}).get("locations") or []
    if not isinstance(locs, list):
        return []

    def clean_level(raw_list):
        out = []
        for raw in raw_list:
            if isinstance(raw, str):
                out.append({"name": raw, "description": "", "children": []})
                continue
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("name") or "").strip()
            if not name:
                continue
            desc = str(raw.get("description") or "").strip()
            children = clean_level(raw.get("children") or [])
            out.append({"name": name, "description": desc, "children": children})
        return out

    return clean_level(locs)


def find_location_path(locations: list, current: str) -> dict | None:
    """在当前地点字符串（如“沙勒”）中匹配世界书地点树，返回最深层命中的路径与说明。
    :return: {"path": [...], "description": "..."} 或 None
    """
    current = (current or "").strip()
    if not current or not isinstance(locations, list):
        return None
    best = None

    def walk(nodes, path):
        nonlocal best
        for node in nodes:
            if not isinstance(node, dict):
                continue
            name = str(node.get("name") or "").strip()
            if not name:
                continue
            nd = path + [name]
            if name in current or current in name:
                if best is None or len(nd) > len(best["path"]):
                    best = {"path": nd, "description": str(node.get("description") or "")}
            walk(node.get("children") or [], nd)

    walk(locations, [])
    return best
