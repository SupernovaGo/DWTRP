"""
服务端提示文案的国际化
========================
前端每个请求都会带上 `X-TRPE-Lang`（zh / en），中间件把它记在这里；
面向用户的提示、报错、任务日志用 `tr("中文原文", 变量=...)` 取词。

设计上与前端的 web/src/i18n 保持一致：**键就是中文原文**，英文词条见 EN。
没有英文词条的字符串会原样返回中文（纯内部字符串、LLM 提示词等不需要翻译）。
"""
from typing import Dict

LANGUAGES = ("zh", "en")
DEFAULT_LANGUAGE = "zh"

_current = {"lang": DEFAULT_LANGUAGE}


def set_language(lang: str) -> None:
    """设置当前语言（由请求中间件或设置变更调用）。"""
    value = (lang or "").strip().lower()
    if value.startswith("en"):
        _current["lang"] = "en"
    elif value.startswith("zh"):
        _current["lang"] = "zh"


def get_language() -> str:
    return _current["lang"]


def is_english() -> bool:
    return _current["lang"] == "en"


def tr(text: str, **params) -> str:
    """按当前语言取词；`{name}` 形式的花括号占位符会被替换。"""
    out = EN.get(text, text) if _current["lang"] == "en" else text
    for key, value in params.items():
        out = out.replace("{" + key + "}", str(value))
    return out


# 英文词条：键 = 服务端代码里的中文原文
EN: Dict[str, str] = {
    # ---------- 会话 / 资源 ----------
    "（默认 / 无会话）": "(default / no session)",
    "尚无当前会话": "No active session",
    "尚无当前会话，请先新建或选择会话": "No active session yet - create or select one first",
    "会话不存在": "Session not found",
    "会话不存在或名称为空": "Session not found, or the name is empty",
    "默认会话不可删": "The default session cannot be deleted",
    "历史条目不存在": "History entry not found",
    "存档点不存在": "Savepoint not found",
    "指令不存在": "Directive not found",
    "指令内容不能为空": "Directive text cannot be empty",
    "世界书不存在": "Worldbook not found",
    "角色不存在": "Character not found",
    "事件不存在": "Event not found",
    "身份不存在": "Identity not found",
    "日志不存在": "Log not found",
    "缺少日志文件名": "Missing log file name",
    "缺少角色 id": "Missing character id",
    "资源库中不存在该角色": "That character is not in the library",
    "已是核心角色或不存在": "Already a core character, or not found",
    "开始对话": "Start chatting",
    "未配置世界书": "No worldbook configured",
    "（尚未选择世界书）": "(no worldbook selected)",
    "存档": "Savepoint",
    "存档·{label}": "{label} · savepoint",
    "自动存档": "Auto savepoint",
    # ---------- 设置 / 系统 ----------
    "大部分更改立即生效；监听地址/端口等需重启服务": "Most changes take effect immediately; host/port changes need a restart",
    "世界书已更新，新建/初始化会话时生效": "Worldbook updated; it applies when a session is created or initialized",
    "已尝试取消关机": "Attempted to cancel the shutdown",
    "TRPE 将在30秒后关机": "TRPE will shut down this PC in 30 seconds",
    "需要明确确认关机": "Shutdown requires explicit confirmation",
    "mock 模式下不执行真实关机": "Real shutdown is disabled in mock mode",
    "仅支持 Windows 关机": "Shutdown is only supported on Windows",
    "仅支持 Windows": "Only supported on Windows",
    "离线模式，不调用真实 LLM": "Offline mode: never calls the real LLM",
    "TRPE 后端服务": "TRPE backend service",
    "配置写入失败：{err}": "Failed to write the config: {err}",
    # ---------- 世界会话 ----------
    "正在理解你的行动…": "Understanding your action…",
    "正在谱写剧情…": "Writing the story…",
    "正在更新世界…": "Updating the world…",
    "正在更新角色状态与规划…": "Updating character states and plans…",
    "正在后台整理并总结记忆…（可继续发送）": "Summarizing memory in the background… (you can keep sending)",
    "{name} 正在回应…": "{name} is responding…",
    "剧情生成失败：{err}": "Story generation failed: {err}",
    "剧情生成结果为空": "Story generation returned nothing",
    "你下达了世界指令，本回合生效：{text}": "You issued a world directive, effective this turn: {text}",
    "没有可重写的回合（可先在设置里开启回合回退）": "No turn to rewrite (enable turn rewind in settings first)",
    "当前会话不支持回退": "This session does not support rewinding",
    "该条目不是剧情总结": "That entry is not a story summary",
    # ---------- 运行环境 ----------
    "已有环境任务正在进行，请等它结束或先取消": "Another environment task is running; wait for it to finish or cancel it",
    "正在安装 torch + sentence-transformers…": "Installing torch + sentence-transformers…",
    "正在下载嵌入模型 {model}…": "Downloading the embedding model {model}…",
    "(默认)": "(default)",
    "无法启动子进程：{err}": "Failed to start the subprocess: {err}",
    "子进程退出码 {code}": "Subprocess exited with code {code}",
    "[已请求取消任务]": "[cancel requested]",
    "当前没有正在进行的任务": "No task is currently running",
    "任务正在启动中，请稍后再试": "The task is still starting, please try again shortly",
    "完成": "Done",
    "已取消": "Cancelled",
    # ---------- LLM ----------
    "未配置 DeepSeek API Key（对话/初始化/更新都需要它）。请任选其一：\n"
    "  1) 界面「设置 → 连接 / 高级」填写（保存到 server/.env，立即生效）\n"
    "  2) 编辑文件 {path} 写入 {env}=sk-xxx\n"
    "  3) 设置环境变量 {env}\n"
    "注意：若环境变量 {env} 存在但是空字符串，会被视为未配置。": (
        "DeepSeek API Key is not configured (chat, initialization and updates all need it). "
        "Pick one of:\n"
        "  1) Fill it in under Settings → Connection / Advanced (saved to server/.env, effective immediately)\n"
        "  2) Edit {path} and add {env}=sk-xxx\n"
        "  3) Set the {env} environment variable\n"
        "Note: if {env} exists but is an empty string, it counts as unset."
    ),
    "{env} 不是有效的 Key（包含非 ASCII 字符）：请在「设置 → 连接 / 高级」重新填写，或检查 {path}。": (
        "{env} is not a valid key (it contains non-ASCII characters): "
        "fill it in again under Settings → Connection / Advanced, or check {path}."
    ),
    "{agent} LLM 调用失败：{err}": "{agent} LLM call failed: {err}",
}
