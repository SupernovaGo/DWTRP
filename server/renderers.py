"""
输出渲染工具
=================
把角色前台 Agent 的结构化 JSON 渲染成终端可读文本。
"""


def _ensure_markers(text: str, left: str, right: str) -> str:
    text = (text or "").strip()
    if not text:
        return ""
    if text.startswith(left) and text.endswith(right):
        return text
    return f"{left}{text}{right}"


def render_front_turn(character_name: str, output: dict,
                      show_thought: bool = False) -> str:
    lines = []
    if show_thought and output.get("thought"):
        lines.append(f"[思考] {output['thought']}")
    for seg in output.get("sequence") or []:
        seg_type = seg.get("type", "speech")
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        if seg_type == "action":
            rendered = _ensure_markers(text, "*", "*")
        else:
            rendered = _ensure_markers(text, "「", "」")
        lines.append(rendered)
    if not lines:
        return f"{character_name} 保持沉默。"
    return "\n".join(lines)


def render_world_changes(changes: list) -> str:
    if not changes:
        return ""
    lines = ["[世界更新]"]
    for change in changes:
        place = change.get("place", "未知地点")
        desc = change.get("description", "")
        lines.append(f"- {change.get('time', '')}｜{place}：{desc}")
    return "\n".join(lines)
