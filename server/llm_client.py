"""
LLM 客户端
===============
只对接 OpenAI-compatible 的 DeepSeek Chat Completions。
不同 Agent 可以从 settings.CONFIG["LLM_AGENTS"] 中读取各自的
model / temperature / max_tokens / thinking / reasoning_effort。
"""
import copy
import json
import re
import time
import uuid

import requests

from llm_logger import log_llm_call
from settings import CONFIG, ENV_PATH, find_api_key


# 模型可能“明确表示无话可说”的文本；与“无法解析的乱码”区分开
EMPTY_OUTPUT_TOKENS = {
    "（空）", "(空)", "空", "无", "暂无", "没有", "无内容", "暂无输出",
    "none", "nil", "null", "empty", "(empty)", "no output",
    "沉默", "无话可说", "……", "...",
}


def detect_empty_output(raw) -> str | None:
    """返回 'empty'（真为空）或 'explicit'（明确写“空/沉默”）或 None。"""
    if raw is None:
        return "empty"
    s = str(raw).strip()
    if not s:
        return "empty"
    if s in EMPTY_OUTPUT_TOKENS:
        return "explicit"
    return None


def _extra_with_thinking(reasoning: str, extra=None, params=None) -> dict:
    """把模型返回的 reasoning_content 与本次调用参数并入日志 extra。"""
    e = dict(extra or {})
    if reasoning:
        e["thinking"] = reasoning
    if params:
        e["params"] = params
    return e


def _drop_invalid_escapes(text: str) -> str:
    """去掉 JSON 中非法转义（如 \\~、\\， 这类模型常见笔误），保留合规转义。"""
    return re.sub(r'\\(?![u"\\/bfnrt])', '', text or "")


def _repair_equals_colon(text: str) -> str:
    """把模型把 ':' 误写成 '=' 的键修复回来。"""
    # 1) "a"="b" / "a" = "b"  ->  "a": "b"
    text = re.sub(r'("(?:\\.|[^"\\])*")\s*=\s*(")', r'\1: \2', text)
    # 2) "key="<裸值>  ->  "key": <裸值>（等号贴在键内、后跟未加引号的值）
    text = re.sub(r'("(?:\\.|[^"\\])*?)="(?=[^"\s,}\]])', lambda m: m.group(1) + '": ', text)
    return text


def _repair_bare_strings(text: str) -> str:
    """给 JSON 中漏掉引号的字符串值补上引号（例如 "text": *动作* -> "text": "*动作*"）。"""
    # 匹配 : 或 = 后面的裸字符串值（非引号/括号/数字/布尔/null 开头）
    pattern = re.compile(
        r'("(?:[^"\\]|\\.)*"\s*[:=]\s*)'
        r'(?!"|\{|\[|-|\d|true|false|null)'
        r'([^\s"\[{][^,\}\]"]*)'
    )

    def repl(m):
        return m.group(1) + '"' + m.group(2) + '"'

    prev = None
    while prev != text:
        prev = text
        text = pattern.sub(repl, text)
    return text


def _remove_extra_quotes(text: str) -> str:
    """塌陷 `}`/`]` 前多余的引号，但要避开 `{"a":""}` 这类合法空字符串。"""
    return re.sub(r'(?<![\s:,\[{])"{2,}(?=\s*[}\]])', '"', text)


_MISSING = object()


def parse_json_response(raw: str):
    """从模型输出中稳健提取 JSON，容忍代码围栏、前后杂文与模型常见笔误。"""
    if not raw:
        return {}
    text = raw.strip()
    if text.startswith("```"):
        # 去掉 ```json 与结尾 ``` 围栏
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return {}
    segment = text[start:end + 1]

    def _try(t):
        for strict in (True, False):
            try:
                r = json.loads(t, strict=strict)
                if r:
                    return r
            except json.JSONDecodeError:
                continue
        return _MISSING

    for strict in (True, False):
        r = _try(segment)
        if r is not _MISSING:
            return r

    # 多级修复：去非法转义 → 补冒号 → 补字符串引号 → 去尾逗号 → 塌陷多余引号
    steps = (
        _drop_invalid_escapes,
        _repair_equals_colon,
        _repair_bare_strings,
        lambda t: re.sub(r",(\s*[}\]])", r"\1", t),
        _remove_extra_quotes,
    )
    repaired = _drop_invalid_escapes(segment)
    for fn in steps:
        repaired = fn(repaired)
        r = _try(repaired)
        if r is not _MISSING:
            return r
    # 多轮补引号 / 去逗号 / 塌陷兜底
    for _ in range(3):
        repaired = _repair_bare_strings(repaired)
        repaired = re.sub(r",(\s*[}\]])", r"\1", repaired)
        repaired = _remove_extra_quotes(repaired)
        r = _try(repaired)
        if r is not _MISSING:
            return r
    return {}


class LLMClient:
    """统一的 DeepSeek Chat Completions 客户端。"""

    def __init__(self, mock: bool = False):
        self.mock = mock
        self.api_base = CONFIG["LLM"]["api_base"]
        self.api_key = find_api_key()
        self.timeout = CONFIG["LLM"]["request_timeout"]
        self.retries = CONFIG["LLM"]["retries"]
        self.agent_configs = CONFIG["LLM_AGENTS"]

    def _agent_cfg(self, agent_name: str) -> dict:
        if agent_name not in self.agent_configs:
            raise KeyError(f"未配置 LLM Agent：{agent_name}")
        return self.agent_configs[agent_name]

    def _payload(self, agent_name: str, messages: list, json_mode: bool = True) -> dict:
        cfg = self._agent_cfg(agent_name)
        payload = {
            "model": cfg["model"],
            "messages": messages,
            "temperature": cfg["temperature"],
            "max_tokens": cfg["max_tokens"],
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        if cfg.get("thinking"):
            payload["thinking"] = {"type": "enabled"}
            if cfg.get("reasoning_effort"):
                payload["reasoning_effort"] = cfg["reasoning_effort"]
        else:
            # 关键：DeepSeek 的 deepseek-v4-flash 在“不带 thinking 字段”时默认开启思考。
            # 必须显式传 thinking:{"type":"disabled"}，才能真正关闭思考、避免浪费推理 token。
            payload["thinking"] = {"type": "disabled"}
        return payload

    @staticmethod
    def _mock_default(agent_name: str):
        defaults = {
            "player": {
                "invoke": [],
                "plot": "",
            },
            "frontend": {
                "think": "",
                "do": "",
            },
            "world_update": {
                "changes": [],
            },
            "memory_summary": {
                "events": [{"summary": "（mock 总结）", "importance": 0.5}],
            },
            "memory_planner": {
                "enough": True,
            },
        }
        return defaults.get(agent_name, {})

    def complete_json(self, agent_name: str, messages: list,
                      default: dict = None, request_id: str = None) -> dict:
        """调用 LLM 并要求返回 JSON 对象。"""
        request_id = request_id or uuid.uuid4().hex[:12]
        if self.mock:
            result = copy.deepcopy(default if default is not None
                                   else self._mock_default(agent_name))
            log_llm_call(request_id, agent_name, messages, "(mock)",
                         parsed=result)
            return result
        last_raw = ""
        try:
            pcfg = self._agent_cfg(agent_name)
            params = {
                "model": pcfg["model"],
                "temperature": pcfg["temperature"],
                "max_tokens": pcfg["max_tokens"],
                "thinking": pcfg.get("thinking", False),
                "reasoning_effort": pcfg.get("reasoning_effort", ""),
            }
        except Exception:  # noqa: BLE001
            params = {}
        # 解析失败最多再补一次（共 2 次）；真正为空则不重试。
        for attempt in range(2):
            raw, reasoning = self._post(agent_name, messages, json_mode=True,
                                        request_id=request_id)
            last_raw = raw
            parsed = parse_json_response(raw)
            empty_kind = detect_empty_output(raw)
            if empty_kind:
                # 真正为空 / 明确“无话可说”。角色前台（frontend）偶尔会“空”一下导致角色沉默，
                # 这里先记一次日志，再重试一次；其余 agent 直接按空处理（空是合法结果）。
                if not (agent_name == "frontend" and attempt == 0):
                    log_llm_call(request_id, agent_name, messages, raw, parsed={},
                                 extra=_extra_with_thinking(reasoning, {"empty": True, "empty_kind": empty_kind}, params))
                    return copy.deepcopy(default) if default is not None else {}
                log_llm_call(request_id, agent_name, messages, raw, parsed={},
                             extra=_extra_with_thinking(reasoning, {"empty": True, "empty_kind": empty_kind,
                                                                    "note": "frontend 首轮空返回，重试一次"}, params))
                time.sleep(1)
                continue
            if parsed:
                _has_visible = bool(parsed.get("sequence") or []) or bool((parsed.get("do") or "").strip())
                # 角色前台若首轮没有可见内容（sequence 为空，即“沉默”），先记日志并重试一次。
                if agent_name == "frontend" and not _has_visible and attempt == 0:
                    log_llm_call(request_id, agent_name, messages, raw, parsed=parsed,
                                 extra=_extra_with_thinking(reasoning, {"empty": True, "empty_kind": "parsed_empty",
                                                                        "note": "frontend 首轮无内容，重试一次"}, params))
                    time.sleep(1)
                    continue
                # 角色前台若没有可见动作/说话（sequence 为空），对玩家而言就是“沉默”。
                # 标记出来，方便在日志里直接看出“角色不开口”的根因（即使只有 thought 也属可见性沉默）。
                silent = (agent_name == "frontend" and not _has_visible)
                extra = _extra_with_thinking(
                    reasoning, {"silent": True, "empty_kind": "parsed_empty"} if silent else None, params)
                log_llm_call(request_id, agent_name, messages, raw, parsed=parsed,
                             extra=extra)
                return parsed
            # 解析失败 / 输出到一半：重试
            if attempt == 0:
                time.sleep(1)
        log_llm_call(request_id, agent_name, messages, last_raw, parsed={},
                     extra=_extra_with_thinking(reasoning, {"unparseable": True}, params))
        # 前台角色：即使解析失败，只要有原始输出，就把原文当作一句说话原样展示，避免角色“凭空消失”。
        if agent_name == "frontend" and last_raw:
            return {"think": "", "do": "", "__raw__": last_raw}
        return copy.deepcopy(default) if default is not None else {}

    def _post(self, agent_name: str, messages: list, json_mode: bool = True,
              request_id: str = None) -> str:
        request_id = request_id or uuid.uuid4().hex[:12]
        # 每次调用前重新解析 Key：手动改 server/.env 后无需重启即可生效，
        # 且环境变量为空字符串时不会被误判为“已配置”。
        self.api_key = find_api_key()
        CONFIG["DEEPSEEK_API_KEY"] = self.api_key
        if not self.api_key:
            env_name = CONFIG["LLM"].get("api_key_env", "DEEPSEEK_API_KEY")
            raise RuntimeError(
                "未配置 DeepSeek API Key（对话/初始化/更新都需要它）。请任选其一：\n"
                "  1) 界面「设置 → 连接 / 高级」填写（保存到 server/.env，立即生效）\n"
                f"  2) 编辑文件 {ENV_PATH} 写入 {env_name}=sk-xxx\n"
                f"  3) 设置环境变量 {env_name}\n"
                f"注意：若环境变量 {env_name} 存在但是空字符串，会被视为未配置。")
        try:
            self.api_key.encode("latin-1")
        except UnicodeEncodeError:
            env_name = CONFIG["LLM"].get("api_key_env", "DEEPSEEK_API_KEY")
            raise RuntimeError(
                f"{env_name} 不是有效的 Key（包含非 ASCII 字符）："
                f"请在「设置 → 连接 / 高级」重新填写，或检查 {ENV_PATH}。")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = self._payload(agent_name, messages, json_mode=json_mode)
        last_err = None
        for attempt in range(self.retries):
            try:
                resp = requests.post(
                    self.api_base,
                    headers=headers,
                    json=payload,
                    timeout=self.timeout,
                )
                resp.raise_for_status()
                data = resp.json()
                msg = data["choices"][0]["message"] or {}
                content = msg.get("content")
                # OpenAI 兼容：content 可能是分段数组
                if isinstance(content, list):
                    content = "".join(
                        seg.get("text", "") for seg in content if isinstance(seg, dict))
                # DeepSeek 推理模型：content 为空但内容在 reasoning_content 时回退，避免“有输出却判空”
                if not content and msg.get("reasoning_content"):
                    content = msg.get("reasoning_content")
                return (str(content or "").strip(),
                        str(msg.get("reasoning_content") or "").strip())
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt + 1 < self.retries:
                    time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"{agent_name} LLM 调用失败：{last_err}")
