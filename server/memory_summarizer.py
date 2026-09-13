"""
记忆总结器
===============
把对话、观察到的事件或角色经历总结成一串「事件」，直接写入单角色的长期记忆。
事件是长期记忆的最小且唯一单位：只保留摘要与重要度，不保存原文，也不再切 chunk。
"""
from llm_client import LLMClient
from prompts_store import get_prompt


def _clamp_float(value, default: float = 0.5) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, v))


def summarize_and_store(memory, text: str, source: str, llm_client: LLMClient,
                        request_id: str = None, context_info: str = None,
                        event_time: str = None) -> dict:
    """总结一段文本并写入指定角色的长期记忆（仅事件）。

    context_info 可选：一段描述当前环境/角色/世界背景的文字，用于让总结
    器在“不了解场景”的情况下仍能产出贴合该角色视角的事件。
    """
    if not text.strip():
        return {"event_ids": [], "event_count": 0}

    user_content = ""
    if context_info:
        user_content += context_info + "\n\n"
    user_content += f"请处理以下文本：\n---\n{text}\n---"

    messages = [
        {"role": "system", "content": get_prompt("memory_summary")},
        {"role": "user", "content": user_content},
    ]
    default = {
        "events": [{"summary": text[:150], "importance": 0.5}],
    }
    parsed = llm_client.complete_json(
        "memory_summary", messages, default=default, request_id=request_id)

    raw_events = parsed.get("events") or []
    events = []
    for ev in raw_events:
        if not isinstance(ev, dict):
            continue
        summary = (ev.get("summary") or ev.get("event_summary") or "").strip()
        if not summary:
            continue
        events.append({
            "summary": summary[:500],
            "importance": _clamp_float(ev.get("importance"), 0.5),
        })

    if not events:
        events = [{"summary": text[:150], "importance": 0.5}]

    ids = memory.add_events_with_time(events, source=source, event_time=event_time)
    return {"event_ids": ids, "event_count": len(ids)}
