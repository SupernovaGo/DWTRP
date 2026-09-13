"""
时间工具
=============
世界时间基于带时区的 datetime 表示，所有持久化均使用 ISO 8601 字符串。
"""
from datetime import datetime, timedelta
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from settings import CONFIG


_TZ_CACHE: dict = {}
_TZ_WARNED = False


def timezone():
    """当前世界时区（config.toml 的 [world] timezone）。

    注意：Windows 没有系统级时区数据库，`zoneinfo` 需要 PyPI 的 `tzdata` 包
    （requirements.txt 已包含）。若该包缺失（或时区名写错），这里**不抛异常**，
    而是退回本机时区并提示一次，避免「新建会话」等操作直接 500。
    """
    global _TZ_WARNED
    name = str(CONFIG.get("TIMEZONE") or "UTC")
    cached = _TZ_CACHE.get(name)
    if cached is not None:
        return cached
    try:
        tz = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        if not _TZ_WARNED:
            _TZ_WARNED = True
            import sys

            print(
                f"[WARN] 找不到时区数据 '{name}'：Windows 需要 tzdata 包"
                "（python -m pip install tzdata），暂时改用本机时区继续运行。",
                file=sys.stderr, flush=True,
            )
        tz = datetime.now().astimezone().tzinfo
    _TZ_CACHE[name] = tz
    return tz


def is_iso(text: str) -> bool:
    """判断字符串是否为合法的 ISO 8601 时间。"""
    text = (text or "").strip()
    if not text:
        return False
    try:
        datetime.fromisoformat(text)
        return True
    except ValueError:
        return False


def parse_iso(text: str) -> datetime:
    text = (text or "").strip()
    if not text:
        return datetime.now(timezone())
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone())
    return dt.astimezone(timezone())


def to_iso(dt: datetime) -> str:
    return dt.astimezone(timezone()).isoformat(timespec="seconds")


def pretty_time(text: str) -> str:
    """把 ISO 时间格式化为『YYYY-MM-DD HH:MM』，去掉秒与 UTC/+08:00；
    非标准/自定义时间原样返回（保留用户填写的年份等信息）。"""
    text = (text or "").strip()
    if not text:
        return ""
    if not is_iso(text):
        return text
    return parse_iso(text).strftime("%Y-%m-%d %H:%M")


def _parse_custom_date(before: str):
    """从日期/时间之前的文本里提取 (year, month, day, has_year, has_date, date_start)。

    优先 Y年/M/D、Y/M/D（三个数字，第一个作年份），再退 Y年[M月[D日]]，最后 M/D；
    月 1-12、日 1-31，超出即视为非法并返回 None（避免解析出“35月7日”这类脏数据）。
    """
    results = []
    # 1) Y/M/D 或 Y年/M/D（三个数字）
    for fmt in (
            r"(\d{1,4})\s*年\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[日号]?",
            r"(\d{1,4})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[日号]?",
    ):
        m = re.search(fmt, before)
        if m:
            y, mo, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if 1 <= y <= 9999 and 1 <= mo <= 12 and 1 <= dd <= 31:
                results.append((2, (y, mo, dd, True, True, m.start())))
    # 2) 中国式 Y年[M月[D日]]
    m = re.search(r"(\d{1,4})\s*年\s*(?:(\d{1,2})\s*月)?\s*(?:(\d{1,2})\s*[日号])?", before)
    if m and m.group(1):
        y = int(m.group(1))
        mo = int(m.group(2)) if m.group(2) else None
        dd = int(m.group(3)) if m.group(3) else None
        if 1 <= y <= 9999 and (mo is None or 1 <= mo <= 12) and (dd is None or 1 <= dd <= 31):
            score = 1 if (mo is not None and dd is not None) else 0
            results.append((score, (y, mo, dd, True, (mo is not None and dd is not None), m.start())))
    # 3) M/D
    m = re.search(r"(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?", before)
    if m:
        mo, dd = int(m.group(1)), int(m.group(2))
        if 1 <= mo <= 12 and 1 <= dd <= 31:
            results.append((0, (None, mo, dd, False, True, m.start())))
    if not results:
        return None
    results.sort(key=lambda r: r[0], reverse=True)
    return results[0][1]


def parse_custom_time(text: str, base: datetime | None = None):
    """把自定义时间字符串解析成 (datetime, has_year, has_date, prefix)。

    解析成功门槛：必须能解析出可比较的完整 datetime（至少含日期，或“时:分”）。
    - 返回 None 表示无法解析（不推进、不参与更新时间比较）。
    - prefix 为时间前的可编辑标签（如“世界标准时”“基沃托斯时间”），**始终保留**（日期/时间之前的部分）。
    - 无年/无日期时用 base（缺省为 START_TIME）补齐年份与日期；只有日期而无时间时沿用 base 的时分。
    """
    text = (text or "").strip()
    if not text:
        return None
    if is_iso(text):
        return parse_iso(text), True, True, ""

    base_dt = base or _start_dt()
    # 找“时:分”
    m_hm = re.search(r"(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?", text)
    before = text[:m_hm.start()] if m_hm else text
    date_part = _parse_custom_date(before)
    if date_part is None:
        # 日期前存在数字但无法解析成合法日期 → 明确拒绝，避免解析成“35月7日”这类脏数据。
        if re.search(r"\d", before):
            return None
        year = month = day = None
        has_year = False
        date_start = None
        has_date = False
    else:
        year, month, day, has_year, has_date, date_start = date_part

    # 时分：没有显式时间时沿用 base 的时分（仅日期也能落为一个完整 datetime）。
    if m_hm:
        hour = int(m_hm.group(1))
        minute = int(m_hm.group(2) or 0)
        amp = re.search(r"(下午|晚上|上午|早上)", text[:m_hm.end()])
        if amp and amp.group(1) in ("下午", "晚上") and hour < 12:
            hour += 12
        if hour > 23 or minute > 59:
            return None
    else:
        hour, minute = base_dt.hour, base_dt.minute

    if not has_date and not m_hm:
        return None
    yy = year if year is not None else base_dt.year
    mo = month if month is not None else base_dt.month
    dd = day if day is not None else base_dt.day
    try:
        dt = datetime(yy, mo, dd, hour, minute, tzinfo=timezone())
    except ValueError:
        return None

    # prefix：日期/时间之前无法解析的文本，始终保留（如“世界标准时”）
    if date_start is not None:
        prefix = text[:date_start].strip()
    elif m_hm:
        prefix = text[:m_hm.start()].strip()
    else:
        prefix = ""
    return dt, has_year, has_date, prefix


def _start_dt() -> datetime:
    from settings import CONFIG
    raw = CONFIG.get("START_TIME", "2001-01-01T00:00:00")
    try:
        return parse_iso(raw)
    except Exception:  # noqa: BLE001
        return datetime(2001, 1, 1, tzinfo=timezone())


def format_custom_time(dt: datetime, has_year: bool, has_date: bool = True,
                       prefix: str = "") -> str:
    """把内部时钟渲染成可编辑时间字符串。

    无年、有日期：M/D H:MM（如 7/15 5:20），前缀始终保留在前面；
    无年、无日期：前缀 + H:MM（如 基沃托斯时间5:20）；
    有年：Y/M/D H:MM。
    """
    dt = dt.astimezone(timezone())
    hm = f"{dt.hour}:{dt.minute:02d}"
    if has_year:
        body = f"{dt.year}/{dt.month}/{dt.day} {hm}"
    elif has_date:
        body = f"{dt.month}/{dt.day} {hm}"
    else:
        body = hm
    if not prefix:
        return body
    return prefix + body if prefix.endswith((" ", "　")) else prefix + " " + body


def add_minutes(iso: str, minutes: int) -> str:
    return to_iso(parse_iso(iso) + timedelta(minutes=minutes))


def parse_hhmm(text: str):
    """把 '12:00' 解析成 (hour, minute)。"""
    hour, minute = (text or "00:00").split(":")
    return int(hour), int(minute)


def crossed_time(prev_iso: str, next_iso: str, hhmm: str) -> bool:
    """判断从 prev 到 next 是否跨越了当天的 hh:mm。"""
    if isinstance(hhmm, (list, tuple)):
        return any(crossed_time(prev_iso, next_iso, t) for t in hhmm)
    if not is_iso(prev_iso) or not is_iso(next_iso):
        # 自定义/未知时间无法做“跨越更新节点”判断，跳过自动更新。
        return False
    target_h, target_m = parse_hhmm(hhmm)
    prev = parse_iso(prev_iso)
    nxt = parse_iso(next_iso)
    target = nxt.replace(hour=target_h, minute=target_m, second=0, microsecond=0)
    if target <= prev:
        target += timedelta(days=1)
    return prev < target <= nxt
