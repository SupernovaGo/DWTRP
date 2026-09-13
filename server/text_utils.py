"""
文本渲染工具
=================
所有字段渲染都根据实际 JSON 内容动态生成，不写死“固定字段列表”。
用户新增、删除或修改角色卡/世界书字段后，渲染结果会自动跟着变化。
  - 角色卡渲染给“扮演模型”时会剔除 tags / is_core / avatar / id 等元字段；
  - 关系网只按标准 relationships 原子渲染；说话风格单独渲染。
"""
import card_schema


FIELD_LABELS = {
    "id": "ID",
    "name": "名字",
    "surname": "姓",
    "intro": "简介",
    "identity": "简介",
    "personality": "性格",
    "appearance": "外观",
    "is_core": "核心角色",
    "aliases": "别名",
    "avatar": "头像",
    "speech_style": "说话风格",
    "relationships": "关系网",
    "position": "位置",
    "mood": "心情",
    "doing": "正在做的事",
    "plan": "规划",
    "time_period": "时间段",
    "location": "地点",
    "action": "行动",
    "relation": "关系",
    "address": "称呼",
    "detail": "详述",
    "affection": "好感",
    "directed": "单向",
    "entries": "设定",
    "keywords": "关键词",
    "importance": "重要程度",
    "info": "信息",
    "description": "说明",
    "time": "时间",
    "place": "地点",
    "weather": "天气",
    "affiliation": "所属",
    "halo": "光环",
    "weapon": "武器",
    "locations": "主要地点",
}


def label(key: str) -> str:
    return FIELD_LABELS.get(key, key)


def _is_empty(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def render_value(value) -> str:
    """把任意 JSON 值渲染成自然语言，尽量保留未知字段。"""
    if isinstance(value, dict):
        if "name" in value and ("relation" in value or "affection" in value):
            parts = []
            if value.get("relation"):
                parts.append(f"关系：{value['relation']}")
            if value.get("affection") not in (None, ""):
                parts.append(f"好感：{value['affection']}")
            suffix = f"（{'，'.join(parts)}）" if parts else ""
            return f"{value.get('name', '')}{suffix}"
        lines = []
        for k, v in value.items():
            if _is_empty(v):
                continue
            lines.append(f"{label(k)}：{render_value(v)}")
        return "；".join(lines)
    if isinstance(value, list):
        return "\n".join(render_value(item) for item in value)
    return str(value)


def render_record(data: dict) -> str:
    """把任意 dict 渲染成「字段：值」文本，未知字段原样保留。"""
    lines = []
    for key, value in data.items():
        if _is_empty(value):
            continue
        rendered = render_value(value)
        if not rendered:
            continue
        lines.append(f"【{label(key)}】{rendered}")
    return "\n".join(lines)


def _render_model_card(entry: dict) -> str:
    """构建“可给模型”的角色卡文本（剔除元字段，格式化关系网/说话风格/外观）。"""
    card = card_schema.for_model(entry)
    lines = []
    name = card_schema.full_display_name(entry)
    identity = card_schema.get_field(entry, "intro", "") or card_schema.get_field(entry, "identity", "")
    personality = card_schema.get_field(entry, "personality", "")
    appearance = card_schema.get_field(entry, "appearance", "")
    if name:
        lines.append(f"【名字】{name}")
    if identity:
        lines.append(f"【简介】{identity}")
    if personality:
        lines.append(f"【性格】{personality}")
    if appearance:
        lines.append(f"【默认外观】{appearance}")

    # 说话风格
    style = card_schema.speech_style_text(entry)
    if style:
        lines.append(f"【说话风格】\n{style}")

    # 关系网
    rels = card_schema.normalize_relationships(entry)
    if rels:
        rel_lines = []
        for r in rels:
            target = r.get("target", "")
            call = r.get("address", "")
            relation = r.get("relation", "")
            detail = r.get("detail", "")
            aff = r.get("affection")
            parts = []
            if call:
                parts.append(f"称呼「{call}」")
            if relation:
                parts.append(f"关系：{relation}")
            if aff is not None:
                parts.append(f"好感度：{float(aff):.2f}")
            if detail:
                parts.append(f"详述：{detail}")
            arrow = "→" if r.get("directed") else "↔"
            rel_lines.append(f"- {target} {arrow} {('；'.join(parts)) if parts else ''}")
        lines.append("【关系网】\n" + "\n".join(rel_lines))

    # 剩余的自定义字段
    for k, v in card.items():
        if k in ("name", "surname", "intro", "identity", "personality", "appearance",
                 "speech_style", "relationships", "tags", "id"):
            continue
        if card_schema._present(v):
            lines.append(f"【{label(k)}】{render_value(v)}")
    return "\n".join(l for l in lines if l.strip())


def render_character_card(entry: dict, max_chars: int = None) -> str:
    """渲染角色卡（剔除元字段、格式化关系网/说话风格），供扮演模型使用。"""
    text = _render_model_card(entry)
    if not text:
        text = "（暂无）"
    if max_chars and len(text) > max_chars:
        text = text[:max_chars] + "\n……（因长度限制截断）"
    return text


def render_world_summary(world_data: dict, max_chars: int = None,
                         include_background: bool = True) -> str:
    """渲染世界书/世界状态摘要：世界名 + 概览 + 背景（+ 基调）。"""
    lines = []
    overview = card_schema.wb_overview(world_data)
    name = card_schema.wb_name(world_data)
    if name:
        lines.append(f"【世界信息】{name}")
    if overview:
        lines.append(overview)
    background = (world_data or {}).get("background") or ""
    if include_background and background and str(background).strip():
        lines.append(f"【背景】{background}")
    tone = world_data.get("tone") if isinstance(world_data, dict) else None
    if tone:
        lines.append(f"【基调】{tone}")
    text = "\n\n".join(x for x in lines if x.strip())
    if not text:
        text = "（暂无）"
    if max_chars and len(text) > max_chars:
        text = text[:max_chars] + "\n……（因长度限制截断）"
    return text


def render_compact_summary(entry: dict) -> str:
    """精简角色摘要：只输出名字/简介/性格，用于初始化与玩家 Agent，减少上下文长度。"""
    if not isinstance(entry, dict):
        return ""
    lines = []
    name = card_schema.full_display_name(entry)
    intro = card_schema.get_field(entry, "intro", "") or card_schema.get_field(entry, "identity", "")
    personality = card_schema.get_field(entry, "personality", "")
    if name:
        lines.append(f"【名字】{name}")
    if intro:
        lines.append(f"【简介】{intro}")
    if personality:
        lines.append(f"【性格】{personality}")
    eng = (entry.get("english_name") or entry.get("id") or "").strip()
    if eng:
        lines.append(f"【英文名】{eng}")
    aliases = card_schema.aliases(entry)
    if aliases:
        lines.append(f"【别名】{', '.join(aliases)}")
    return "\n".join(lines) if lines else (f"【名字】{name}" if name else "（暂无）")


def truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "……"
