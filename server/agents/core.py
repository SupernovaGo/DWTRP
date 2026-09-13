"""
世界模拟的 Agent
==================================
  - PlayerAgent            玩家 Agent：维护环境感知、决定调用哪些角色、提供 update_hints
  - EnvironmentAgent       可观测环境 Agent：更新玩家可见环境、给角色/世界更新提供附加信息
  - FrontAgent             角色前台 Agent：生成某角色的思考/动作/说话
  - CharacterUpdateAgent   角色更新 Agent：时间节点更新角色状态/规划/关系，实际上拆分成了记忆更新和规划更新两个Agent
  - WorldUpdateAgent       世界更新 Agent：推进时间线中的宏观世界变化
"""
import re
from concurrent.futures import ThreadPoolExecutor

from llm_client import LLMClient
from llm_logger import log_event
from prompts_store import get_prompt
from prompts import BASE_WORLD_RULES
from settings import CONFIG
from settings import read_player_char_detail as _read_player_char_detail
from settings import read_core_only_update as _read_core_only_update
from text_utils import render_character_card, render_record
import card_schema


def _format_timeline(events: list) -> str:
    if not events:
        return "（暂无）"
    lines = []
    for ev in events:
        lines.append(
            f"[{ev.get('time', '')}] {ev.get('place', '')}："
            f"{ev.get('description', '')}"
        )
    return "\n".join(lines)


def _recent_world_changes(world, limit: int = 8) -> str:
    """近期世界变化（时间线），作为更新 Agent 的“上次世界更新内容”。"""
    return _format_timeline(world.recent_timeline(limit))


def _world_identity_block(world, characters) -> str:
    """玩家/环境/角色前台共享前缀：世界书摘要+ 背景 + 玩家身份。"""
    parts = [world.world_summary(include_background=False)]
    bg = world.world_background()
    if bg:
        parts.append(f"【背景】\n{bg}")
    parts.append(f"【玩家信息】\n{render_record(characters.user_identity)}")
    return "\n\n".join(parts)


def _world_update_context(world) -> str:
    """角色/世界更新 Agent 的系统前缀：世界书摘要 + 背景 + 世界书全部地点。"""
    parts = [world.world_summary(include_background=False)]
    bg = world.world_background()
    if bg:
        parts.append(f"【背景】\n{bg}")
    locs = world.location_context_text()
    if locs:
        parts.append(f"【已知地点】\n{locs}")
    return "\n\n".join(parts)


def _build_system(agent_key: str, world_context: str) -> str:
    """把“基础规则 + 世界上下文 + 该 Agent 规则”拼成系统提示词，命中 KV 缓存。

    prompts_store 里存的是“基础规则 + 规则”的完整串；这里把基础规则剥离，
    在其后插入当前会话的世界上下文，再拼接该 Agent 规则。
    """
    full = get_prompt(agent_key)
    agent_rules = full[len(BASE_WORLD_RULES):] if full.startswith(BASE_WORLD_RULES) else full
    return BASE_WORLD_RULES + "\n\n" + world_context + "\n\n" + agent_rules


def _scene_lines(scene_history: list, exclude_names=("背景",)) -> list:
    """从场景历史中抽取“事件行”（去掉背景/旁白/开场）。"""
    lines = []
    for line in scene_history or []:
        m = re.match(r"^\[([^\]]+)\]\s*([\s\S]*)$", line or "")
        if m and m.group(1) in exclude_names:
            continue
        lines.append(line)
    return lines


def _recent_player_history(scene_history: list, limit: int = None,
                           exclude_names=("背景",)) -> str:
    """近期事件：去掉开场背景行，保留最近 limit 条交互。"""
    limit = int(limit if limit is not None else CONFIG.get("SCENE_HISTORY_LIMIT", 5))
    lines = _scene_lines(scene_history, exclude_names)
    return "\n".join(lines[-limit:]) if lines else "（暂无）"


def _render_plan_table(state: dict) -> str:
    """把角色当前规划渲染成多条“序号. 时间-地点-干什么”的文本。"""
    plan = (state or {}).get("current_plan") or (state or {}).get("plan") or {}
    return card_schema.render_plan_text(plan)


def _parse_do(text: str) -> list:
    """把前台模型的 do 字段解析成 [{type, text}]。

    do 是“动作 + 说话”按顺序拼成的串：动作用 *...* 包裹、说话用 「...」 包裹。
    解析时先抽动作（*...*），再在剩余文本里抽说话（「...」），因此动作里若混入
    「...」也会被当作动作内容，不会被误拆。
    """
    raw = (text or "").strip()
    if not raw:
        return []
    def frag(s: str) -> bool:
        return s.strip() in ("", "**", "*", "「", "」", "「」", "...", "……")
    toks = []
    pos = 0
    for m in re.finditer(r"\*+([^*]+)\*+", raw):
        if m.start() > pos:
            toks.append(("plain", raw[pos:m.start()]))
        toks.append(("action", m.group(1)))
        pos = m.end()
    if pos < len(raw):
        toks.append(("plain", raw[pos:]))
    segs = []
    for kind, part in toks:
        if kind == "action":
            body = part.strip()
            if body and not frag(body):
                segs.append({"type": "action", "text": body})
            continue
        p = 0
        for m in re.finditer(r"「+([^」]+)」+", part or ""):
            if m.start() > p:
                tail = part[p:m.start()].strip()
                if tail and not frag(tail):
                    segs.append({"type": "speech", "text": tail})
            body = m.group(1).strip()
            if body and not frag(body):
                segs.append({"type": "speech", "text": body})
            p = m.end()
        tail = (part or "")[p:].strip()
        if tail and not frag(tail):
            segs.append({"type": "speech", "text": tail})
    if not segs and raw:
        segs.append({"type": "speech", "text": raw})
    return segs


# ---------------------------------------------------------------------------
# 玩家 Agent
# ---------------------------------------------------------------------------
class PlayerAgent:
    def __init__(self, world_state, characters, llm_client: LLMClient, get_memory=None):
        self.world = world_state
        self.characters = characters
        self.llm = llm_client
        self.get_memory = get_memory

    def process(self, player_input: str, scene_history: list,
                request_id: str = None, directive: str = "",
                world_entries: str = "", recent_events: str = None) -> dict:
        # 玩家 Agent 只负责决定调用哪些角色；环境/提示/更新附加信息交给可观测环境 Agent。
        system_content = _build_system(
            "player", _world_identity_block(self.world, self.characters))
        # 只列出可能与玩家交互的角色；按设置决定给全量还是精简信息。
        detail = str(_read_player_char_detail()).strip().lower()
        character_summaries = self.characters.render_player_relevant_summaries(
            self.world.perception.get("location") or "",
            player_input, detail=detail)

        timeline = _recent_world_changes(self.world, 8)
        perception = self.world.current_environment_text()
        user_name = self.characters.user_identity.get("name", "玩家")
        history_text = recent_events if recent_events is not None else _recent_player_history(scene_history)
        directive_text = directive.strip()
        directive_block = f"{directive_text}\n\n" if directive_text else ""
        world_entries_text = (world_entries or "").strip()
        world_entries_block = f"\n\n{world_entries_text}" if world_entries_text else ""
        user_content = (
            f"【近期世界变化】\n{timeline}\n\n"
            f"【可能与玩家交互的角色】\n{character_summaries}\n\n"
            f"【近期事件】\n{history_text}\n\n"
            f"【词条信息】\n{world_entries_block.strip() if world_entries_block else '（无）'}\n\n"
            f"【世界指令】\n{directive_block.strip() if directive_block else '（无）'}\n\n"
            f"【当前环境】\n{perception}\n\n"
            f"{user_name}：{player_input}\n"
            "请输出 JSON。"
        )
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]
        default = {"invoke": [], "plot": ""}
        out = self.llm.complete_json(
            "player", messages, default=default, request_id=request_id)

        # 兼容字符串形式
        invoke = []
        for item in out.get("invoke") or []:
            if isinstance(item, str):
                invoke.append({"character": item, "condition": "", "info": ""})
            elif isinstance(item, dict):
                invoke.append({
                    "character": item.get("character", ""),
                    "condition": item.get("condition", ""),
                    "info": item.get("info", ""),
                })
        out["invoke"] = invoke
        out["plot"] = str(out.get("plot") or "").strip()
        return out


# ---------------------------------------------------------------------------
# 可观测环境 Agent
# ---------------------------------------------------------------------------
class EnvironmentAgent:
    """可观测环境 Agent：更新玩家可见环境，并给出角色/世界更新需要的附加信息。

    在玩家 Agent 决定调用哪些角色后启动，与角色前台 Agent 并行；本进程只负责
    计算输出（environment/hints/update_hints），不直接改世界，由会话层统一生效。
    """

    def __init__(self, world_state, characters, llm_client: LLMClient):
        self.world = world_state
        self.characters = characters
        self.llm = llm_client

    def process(self, player_input: str, invoke_info: list, scene_history: list,
                request_id: str = None, directive: str = "",
                world_entries: str = "", recent_events: str = None,
                scene_context: str = "") -> dict:
        system_content = _build_system(
            "environment", _world_identity_block(self.world, self.characters))
        timeline = _recent_world_changes(self.world, 8)
        # 带稳定标记（#T/#L/#W/#D...）的环境文本，供 Agent 做“仅更新变化条目”的稀疏更新。
        perception = self.world.tagged_environment_text()
        user_name = self.characters.user_identity.get("name", "玩家")
        history_text = recent_events if recent_events is not None else _recent_player_history(scene_history)
        directive_text = directive.strip()
        directive_block = f"{directive_text}\n\n" if directive_text else ""
        world_entries_text = (world_entries or "").strip()
        world_entries_block = f"\n\n{world_entries_text}" if world_entries_text else ""
        locations_text = self.world.location_context_text()
        locations_block = f"【已知地点】\n{locations_text}" if locations_text else "【已知地点】\n（无）"
        scene_context_block = (scene_context or "").strip()
        scene_context_text = f"{scene_context_block}" if scene_context_block else ""
        user_content = (
            f"{locations_block}\n\n"
            f"【近期世界变化】\n{timeline}\n\n"
            f"【近期事件】\n{history_text}\n\n"
            f"【词条信息】\n{world_entries_block.strip() if world_entries_block else '（无）'}\n\n"
            f"【世界指令】\n{directive_block.strip() if directive_block else '（无）'}\n\n"
            f"【当前环境】\n{perception}\n\n"
            f"{user_name}：{player_input}\n\n"
            f"{scene_context_text}\n\n"
            "请输出 JSON。"
        )
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]
        default = {"environment": {}, "hints": [], "update_hints": []}
        out = self.llm.complete_json(
            "environment", messages, default=default, request_id=request_id)
        out.setdefault("environment", {})
        out.setdefault("hints", [])
        out.setdefault("update_hints", [])
        return out


# ---------------------------------------------------------------------------
# 角色前台 Agent
# ---------------------------------------------------------------------------
class FrontAgent:
    def __init__(self, world_state, characters, llm_client: LLMClient,
                 get_memory):
        self.world = world_state
        self.characters = characters
        self.llm = llm_client
        self.get_memory = get_memory

    def act(self, character_id: str, player_input: str,
            scene_context: str = "", info: str = "",
            request_id: str = None, directive: str = "",
            world_entries: str = "", isolated: bool = False) -> dict:
        rec = self.characters.get(character_id)
        if rec:
            card_text = render_character_card(rec["card"])
        else:
            card_text = ("（该角色没有角色卡：若下方向你提供了「角色信息补充」，请完全按它扮演；"
                         "否则请根据玩家提到的角色身份，自行构造其形象、性格与语气来扮演 TA。）")
        memory = self.get_memory(character_id)
        memory_context = self._resolve_memory_context(
            memory, player_input, character_id, request_id)
        working_memory = memory.working_text() or "（暂无）"
        environment = self._environment_text(isolated)
        system_content = _build_system(
            "frontend", _world_identity_block(self.world, self.characters))
        plan_text = _render_plan_table(self.characters.state(character_id))

        info_block = f"【角色信息补充】\n{info}" if (info or "").strip() else ""
        world_entries_text = (world_entries or "").strip()
        world_entries_block = f"【词条信息】\n{world_entries_text}" if world_entries_text else "（无）"
        directive_text = (directive or "").strip()
        directive_block = f"【世界指令】\n{directive_text}" if directive_text else ""
        scene_block = f"\n{scene_context}" if (scene_context or "").strip() else ""

        parts = [
            f"【你负责扮演】：\n{card_text}",
            f"【本时间段规划】\n{plan_text}",
            f"【近期事件】\n{working_memory}",
            f"【该角色的部分记忆】\n{memory_context}",
        ]
        parts.append(world_entries_block)
        if directive_block:
            parts.append(directive_block)
        parts.append(f"【当前环境】\n{environment}")
        if info_block:
            parts.append(info_block)
        parts.append(f"{player_input}")
        if scene_block:
            parts.append(scene_block)
        parts.append("请以扮演角色的身份输出 JSON。")
        user_content = "\n\n".join(parts)
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ] 
        default = {"think": "", "do": ""}
        out = self._call(messages, default, character_id, request_id=request_id)
        if not isinstance(out, dict):
            out = default
        # 新格式：think + do（do 内动作 *...*、说话「...」）；兼容旧格式 thought + sequence
        thought = str(out.get("think", out.get("thought", "")) or "")
        do_raw = out.get("do")
        if out.get("__raw__"):
            # 解析失败但模型有原始输出：原样作为一句说话展示。
            sequence = [{"type": "speech", "text": str(out["__raw__"])}]
        elif isinstance(do_raw, str):
            sequence = _parse_do(do_raw)
        else:
            sequence = []
            for seg in out.get("sequence") or []:
                if isinstance(seg, str):
                    sequence.append({"type": "speech", "text": seg})
                elif isinstance(seg, dict):
                    sequence.append({
                        "type": seg.get("type", "speech"),
                        "text": seg.get("text", ""),
                    })
        out = {
            "character_id": character_id,
            "thought": thought,
            "sequence": sequence,
        }
        return out

    def _environment_text(self, isolated: bool = False) -> str:
        """角色当前环境文本；隔离（私密）场景只给时间与天气。"""
        perception = self.world.perception or {}
        if isolated:
            lines = [
                f"时间：{self._pretty(perception.get('time', ''))}",
                f"天气：{perception.get('weather', '')}",
            ]
            return "\n".join(lines)
        return self.world.current_environment_text()

    @staticmethod
    def _pretty(text: str) -> str:
        from time_utils import pretty_time
        return pretty_time(text)

    # ---------- 记忆检索（可开关的多轮改写） ----------
    def _resolve_memory_context(self, memory, player_input, character_id,
                                request_id):
        if CONFIG.get("AGENTIC_RETRIEVAL"):
            try:
                return self._agentic_memory_context(
                    memory, player_input, character_id, request_id)
            except Exception as e:  # noqa: BLE001
                log_event(request_id or "", "memory_context_failed",
                          {"character": character_id, "error": str(e)})
                return "（暂无）"
        try:
            return memory.format_memory_context(player_input)
        except Exception as e:  # noqa: BLE001  嵌入模型不可用时降级，不卡主流程
            log_event(request_id or "", "memory_context_failed",
                      {"character": character_id, "error": str(e)})
            return "（暂无）"

    def _agentic_memory_context(self, memory, player_input, character_id,
                                request_id) -> str:
        rounds = max(1, int(CONFIG.get("MAX_RETRIEVAL_ROUNDS", 3)))
        max_chars = int(CONFIG.get("MAX_CONTEXT_CHARS", 4096))
        seen = set()
        collected = []
        query = player_input

        for _ in range(rounds):
            try:
                found = memory.retrieve(query)
            except Exception as e:  # noqa: BLE001
                log_event(request_id or "", "memory_context_failed",
                          {"character": character_id, "error": str(e)})
                found = []
            for s in found or []:
                eid = s.get("event_id")
                if eid and eid not in seen:
                    collected.append(s)
                    seen.add(eid)

            decision = self._planner_decide(
                memory, query, player_input, collected, request_id)
            if decision.get("enough", True):
                break

            expand = decision.get("expand_event_ids") or []
            for eid in expand:
                if eid in seen:
                    continue
                ev = memory.get_event(eid)
                if ev:
                    collected.append(ev)
                    seen.add(eid)

            nq = (decision.get("rewritten_query") or "").strip()
            if nq and nq != query:
                query = nq
            elif not expand:
                break

        return self._format_collected(memory, collected, max_chars)

    def _planner_decide(self, memory, query, player_input, collected,
                        request_id) -> dict:
        fmt = memory.format_events(collected) if collected else "（无）"
        messages = [
            {"role": "system", "content": get_prompt("memory_planner")},
            {"role": "user", "content": (
                f"玩家输入：{player_input}\n"
                f"当前已检索到的记忆：\n{fmt}\n"
                f"本轮使用的检索词：{query}\n"
                "请判断这些记忆是否足以回答玩家的问题。")
            },
        ]
        try:
            return self.llm.complete_json(
                "memory_planner", messages, default={"enough": True},
                request_id=request_id)
        except Exception as e:  # noqa: BLE001
            log_event(request_id or "", "memory_planner_failed", {"error": str(e)})
            return {"enough": True}

    def _format_collected(self, memory, collected, max_chars) -> str:
        parts = []
        used = 0
        for s in collected:
            block = (f"[事件 {s['event_id']}] 重要度 {s.get('importance', 0):.2f}\n"
                     f"事件总结：{s.get('summary', '')}")
            if used + len(block) > max_chars:
                break
            parts.append(block)
            used += len(block)
        return "\n\n".join(parts) if parts else "（暂无）"

    def _call(self, messages, default, character_id, request_id=None) -> dict:
        try:
            # 非流式：一次完整请求；complete_json 内部仅在解析失败时补一次。
            out = self.llm.complete_json(
                "frontend", messages, default=default, request_id=request_id)
            return out if isinstance(out, dict) else default
        except Exception as e:  # noqa: BLE001  网络/超时等失败，直接按沉默处理
            log_event(request_id or "", "frontend_failed",
                      {"character": character_id, "error": str(e)})
            return default


# ---------------------------------------------------------------------------
# 角色更新 Agent
# ---------------------------------------------------------------------------
class CharacterUpdateAgent:
    def __init__(self, world_state, characters, llm_client: LLMClient, get_memory):
        self.world = world_state
        self.characters = characters
        self.llm = llm_client
        self.get_memory = get_memory

    def run(self, player_update_hints: list = None,
            character_ids: list = None, request_id: str = None,
            world_changes: list = None, world_entries: str = "",
            update_window: str = None, directive: str = "") -> list:
        """同步生成 + 应用（用于手动前台更新）。"""
        fetched = self.generate(
            player_update_hints=player_update_hints, character_ids=character_ids,
            request_id=request_id, world_changes=world_changes,
            world_entries=world_entries, update_window=update_window,
            directive=directive)
        return self.apply(fetched, request_id=request_id)

    def generate(self, player_update_hints: list = None,
                 character_ids: list = None, request_id: str = None,
                 world_changes: list = None, world_entries: str = "",
                 update_window: str = None, directive: str = "") -> list:
        """走「记忆总结」+「角色规划」两个 agent 生成更新结果。

        每个批次作为一个任务：先 memory、后 plan（依赖该批 memory 结果即调用规划），
        各批次并行，从而在「某一批 return memory 后立即对它规划」，减少总时长。
        """
        ids = character_ids or self.characters.all_ids()
        if _read_core_only_update():
            core = set(self.characters.core_ids())
            ids = [c for c in ids if c in core]
        batch_size = max(1, int(CONFIG.get("UPDATE_BATCH_SIZE", 10) or 10))
        batches = self._batch_characters_by_tags(ids, batch_size)
        if not batches:
            return []
        all_cids = list(ids)
        max_workers = max(1, min(len(batches), int(CONFIG.get("UPDATE_MAX_WORKERS", 8) or 8)))

        def one_batch(batch: list):
            mem = self._fetch_batch_memory(
                batch, player_update_hints, request_id, world_changes,
                world_entries, update_window, directive, all_cids)
            if not mem:
                return []
            plans = self._fetch_batch_plans(
                batch, mem, player_update_hints, request_id, world_changes,
                world_entries, update_window, directive, all_cids)
            return self._merge_memory_plans(mem, plans)

        fetched = [None] * len(batches)
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            futures = {ex.submit(one_batch, b): i for i, b in enumerate(batches)}
            for fut, i in futures.items():
                try:
                    fetched[i] = fut.result()
                except Exception as e:  # noqa: BLE001
                    log_event(request_id or "", "character_update_batch_failed",
                              {"error": str(e)}, session_id=None)
                    fetched[i] = []
        return fetched

    def apply(self, fetched: list, request_id: str = None,
              window_start: str = None) -> list:
        """把 generate() 的结果逐批应用到角色状态与记忆（含长期记忆写入/嵌入）。"""
        window_start = window_start or self.world.last_update_time()
        summary = []
        for updates in fetched:
            summary.extend(self._apply_updates(
                updates, request_id, window_start=window_start))
        return summary

    def _batch_characters_by_tags(self, ids: list, batch_size: int) -> list:
        """纯随机切分批次：先打乱角色顺序，再按 batch_size 均分。

        记忆总结与角色规划使用同一批划分，保证某批记忆返回后可立即为该批规划。
        """
        ids = list(ids or [])
        if not ids:
            return []
        import random
        random.shuffle(ids)
        return [ids[i:i + batch_size] for i in range(0, len(ids), batch_size)]

    def _context_for_memory(self, player_update_hints: list,
                        world_changes: list = None,
                        world_entries: str = "",
                        update_window: str = None,
                        directive: str = "",
                        all_cids: list = None) -> str:
        hints = "\n".join(f"- {h}" for h in (player_update_hints or []))
        time_window = update_window or self.world.update_window_text()
        directive_text = (directive or "").strip()
        parts = [
            f"【更新时间段】\n{time_window}",
            f"【附加信息】\n{hints or '（无）'}",
        ]
        if directive_text:
            parts.append(f"【世界指令】\n{directive_text}")
        parts.append(f"【近期世界变化】\n{_recent_world_changes(self.world, 8)}")
        if all_cids:
            names = [self.characters.display_name(c) for c in all_cids]
            parts.append("【全部更新角色】\n" + "\n".join(f"- {n}" for n in names))
        return "\n\n".join(parts)

    def _context_for_plan(self, player_update_hints: list,
                        world_changes: list = None,
                        world_entries: str = "",
                        directive: str = "",
                        all_cids: list = None) -> str:
        hints = "\n".join(f"- {h}" for h in (player_update_hints or []))
        directive_text = (directive or "").strip()
        parts = [
            f"【规划时间范围】\n{self.world.current_time_iso()}~{self.world.next_update_time_text()}\n",
            f"【附加信息】\n{hints or '（暂无）'}",
        ]
        if directive_text:
            parts.append(f"【世界指令】\n{directive_text}")
        parts.append(f"【近期世界变化】\n{_recent_world_changes(self.world, 8)}")
        if all_cids:
            names = [self.characters.display_name(c) for c in all_cids]
            parts.append("【全部更新角色】\n" + "\n".join(f"- {n}" for n in names))
        return "\n\n".join(parts)

    def _fetch_batch_memory(self, cids: list, player_update_hints: list,
                            request_id: str = None, world_changes: list = None,
                            world_entries: str = "", update_window: str = None,
                            directive: str = "", all_cids: list = None) -> list:
        """记忆总结：为这些角色生成长期记忆（memory_events）+ 性格/关系变化。"""
        if not cids:
            return []
        parts = []
        for cid in cids:
            rec = self.characters.get(cid)
            is_core = bool(rec and rec["is_core"])
            detail_note = "（核心角色）" if is_core else ""
            memory = self.get_memory(cid)
            plan = _render_plan_table(self.characters.state(cid))
            long_term = self._truncate(memory.recent_event_summaries_text(10), 1500)
            working = self._truncate(memory.working_text() or "（暂无）", 2500)
            parts.append(
                f"### {cid} {detail_note}\n"
                f"【角色卡】\n{self.characters.render_card(cid)}\n\n"
                f"【该时间段规划】\n{plan}\n\n"
                f"【已有经历总结】\n{long_term}\n\n"
                f"【近期事件】\n{working}"
            )
        summaries = "\n\n".join(parts)
        user_content = (
            self._context_for_memory(player_update_hints, world_changes, world_entries,
                                 update_window=update_window, directive=directive,
                                 all_cids=all_cids) +
            f"\n\n【本次更新角色】\n{summaries}\n\n"
            "请按规则输出。"
        )
        system_content = _build_system(
            "character_memory", _world_update_context(self.world))
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]
        default = {"updates": []}
        out = self._retry_complete(messages, default, request_id,
                                   agent_key="character_memory")
        return self._normalize_updates(out, fallback_cid=None)

    def _fetch_batch_plans(self, cids: list, memories: list,
                           player_update_hints: list, request_id: str = None,
                           world_changes: list = None, world_entries: str = "",
                           update_window: str = None, directive: str = "",
                           all_cids: list = None) -> list:
        """角色规划：依据记忆总结阶段的近期经历，为这些角色生成下一时段规划。"""
        if not cids:
            return []
        # 按角色归集本批次记忆摘要（作为“近期经历”）
        mem_by_cid = {}
        for m in memories or []:
            if not isinstance(m, dict):
                continue
            rc = self.characters.resolve(m.get("character") or "") or m.get("character")
            if not rc:
                continue
            segs = []
            for ev in m.get("memory_events") or []:
                summary = ev.get("summary") if isinstance(ev, dict) else str(ev)
                if summary:
                    segs.append(str(summary))
            if segs:
                mem_by_cid.setdefault(rc, []).extend(segs)

        parts = []
        for cid in cids:
            rec = self.characters.get(cid)
            is_core = bool(rec and rec["is_core"])
            detail_note = "（核心角色）" if is_core else ""
            plan = _render_plan_table(self.characters.state(cid))
            exp = "；".join(mem_by_cid.get(cid, [])[:8]) or "（暂无）"
            parts.append(
                f"### {cid} {detail_note}\n"
                f"【角色卡】\n{self.characters.render_card(cid)}\n\n"
                f"【近期经历】\n{exp}\n\n"
                f"【该时间段规划】\n{plan}"
            )
        summaries = "\n\n".join(parts)

        user_content = (
            self._context_for_plan(player_update_hints, world_changes, world_entries,
                                directive=directive,
                                 all_cids=all_cids) +
            f"\n\n【本次规划角色】\n{summaries}\n\n"
            "请按规则输出。"
        )
        system_content = _build_system(
            "character_plan", _world_update_context(self.world))
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]
        default = {"updates": []}
        out = self._retry_complete(messages, default, request_id,
                                   agent_key="character_plan")
        return self._normalize_updates(out, fallback_cid=None)

    def _merge_memory_plans(self, mem_updates: list, plan_updates: list) -> list:
        """把记忆结果与规划结果按角色合并成一条条 [{character, memory_events, next_plan, ...}]。"""
        plan_by = {}
        for p in plan_updates or []:
            if not isinstance(p, dict) or not p.get("character"):
                continue
            key = self.characters.resolve(p["character"]) or p["character"]
            plan_by[key] = p
        merged = []
        for m in mem_updates or []:
            if not isinstance(m, dict):
                continue
            entry = dict(m)
            key = self.characters.resolve(m.get("character") or "") or m.get("character")
            p = plan_by.get(key)
            if p and p.get("next_plan") is not None:
                entry["next_plan"] = p["next_plan"]
            merged.append(entry)
        for key, p in plan_by.items():
            if not any((self.characters.resolve(e.get("character") or "") or e.get("character")) == key
                       for e in merged):
                merged.append(p)
        return merged

    @staticmethod
    def _truncate(text: str, limit: int) -> str:
        text = (text or "").strip()
        if not text:
            return ""
        return text if len(text) <= limit else text[:limit] + "……（截断）"

    def _retry_complete(self, messages, default, request_id,
                        agent_key: str = "character_memory"):
        last = default
        for attempt in range(2):
            out = self.llm.complete_json(
                agent_key, messages, default=default, request_id=request_id)
            last = out
            if (out.get("updates") or out.get("character")):
                return out
        return last

    @staticmethod
    def _normalize_updates(out: dict, fallback_cid=None) -> list:
        if isinstance(out.get("updates"), list):
            return out["updates"]
        if out.get("character") or fallback_cid:
            return [out]
        return []

    def _apply_updates(self, updates: list, request_id: str = None,
                       window_start: str = None) -> list:
        applied = []
        window_start = window_start or self.world.last_update_time()
        for upd in updates:
            if not isinstance(upd, dict):
                continue
            cid = upd.get("character")
            if cid:
                cid = self.characters.resolve(cid) or cid
            if not cid or not self.characters.get(cid):
                continue
            if isinstance(upd.get("persona_changes"), dict) and upd["persona_changes"]:
                self.characters.update_card(cid, upd["persona_changes"])
            next_plan = upd.get("next_plan")
            if next_plan is not None:
                self.characters.update_state(
                    cid, {"current_plan": card_schema.normalize_plan(next_plan)})
            self.characters.update_state(cid, {"last_updated": self.world.current_time_iso()})

            rel_changes = upd.get("relationship_changes") or []
            if isinstance(rel_changes, list):
                for rel in rel_changes:
                    if isinstance(rel, dict) and rel.get("target"):
                        self.characters.add_relationship(cid, rel)

            memory_events = upd.get("memory_events") or []
            if isinstance(memory_events, list) and memory_events:
                # “真正记忆”直接写入长期记忆；不再调用独立总结器。
                events = []
                for x in memory_events:
                    event_time = window_start
                    if isinstance(x, str):
                        summary = x.strip()
                        importance = 0.5
                    elif isinstance(x, dict):
                        summary = (x.get("summary") or x.get("event_summary") or "").strip()
                        try:
                            importance = float(x.get("importance", 0.5))
                        except (TypeError, ValueError):
                            importance = 0.5
                        # 允许每条“真正记忆”自带时间；缺省用更新时间段的起始时间，保证顺序合理。
                        event_time = x.get("time") or window_start
                    else:
                        continue
                    if not summary:
                        continue
                    events.append({
                        "summary": summary[:500],
                        "importance": max(0.0, min(1.0, importance)),
                        "time": event_time,
                    })
                if events:
                    memory = self.get_memory(cid)
                    memory.add_events_with_time(
                        events, source="character_memory",
                        event_time=None)  # 用每条事件自带的 time
                    # 标记：这之前的近期记忆信息已经形成长期记忆，超容时可先截断。
                    memory.mark_working_memory()
            applied.append({"character": cid, "updated": True})
        return applied


# ---------------------------------------------------------------------------
# 世界更新 Agent
# ---------------------------------------------------------------------------
class WorldUpdateAgent:
    def __init__(self, world_state, characters, llm_client: LLMClient):
        self.world = world_state
        self.characters = characters
        self.llm = llm_client

    def run(self, player_update_hints: list = None,
            character_update_summary: list = None,
            request_id: str = None, world_entries: str = "",
            update_window: str = None, directive: str = "") -> list:
        """同步生成 + 应用（手动前台更新）。"""
        changes = self.generate(
            player_update_hints=player_update_hints,
            character_update_summary=character_update_summary,
            request_id=request_id, world_entries=world_entries,
            update_window=update_window, directive=directive)
        return self.apply(changes)

    def generate(self, player_update_hints: list = None,
                 character_update_summary: list = None,
                 request_id: str = None, world_entries: str = "",
                 update_window: str = None, directive: str = "") -> list:
        """只调用 LLM 生成世界变化（不写入世界），返回原始 changes。

        用于后台更新：此阶段不持锁，耗时较长，后台生成期间前台仍可发消息。
        """
        timeline_text = _recent_world_changes(self.world, 10)
        hints_text = "\n".join(f"- {h}" for h in (player_update_hints or [])) or "（无）"
        char_updates = "\n".join(
            f"- {u.get('character', '')}" for u in (character_update_summary or [])
        ) or "（无）"
        time_window = update_window or self.world.update_window_text()
        directive_text = (directive or "").strip()
        directive_block = f"【世界指令】\n{directive_text}\n\n" if directive_text else ""

        user_content = (
            f"【更新时间段】\n{time_window}\n\n"
            f"【附加信息】\n{hints_text}\n\n"
            f"{directive_block}"
            f"【近期世界变化】\n{timeline_text}\n\n"
            f"【近期角色变化】\n{char_updates}\n\n"
            "请输出世界变化 JSON。"
        )
        system_content = _build_system(
            "world_update", _world_update_context(self.world))
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]
        default = {"changes": []}
        last = default
        for attempt in range(2):
            out = self.llm.complete_json(
                "world_update", messages, default=default, request_id=request_id)
            last = out
            if out.get("changes"):
                break
        out = last
        changes = [c for c in (out.get("changes") or []) if isinstance(c, dict)]
        return changes

    def apply(self, changes: list) -> list:
        """把 generate() 得到的 changes 应用到世界（写入时间线/状态/天气）。"""
        self.world.apply_world_changes(changes)
        return changes
