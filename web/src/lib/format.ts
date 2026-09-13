const WEATHER_MAP: Array<[RegExp, string]> = [
  [/冰雹|冰粒/i, '🌨️'],
  [/雷雨|雷|风暴/i, '⛈️'],
  [/雪|飘雪/i, '❄️'],
  [/小雨|阵雨/i, '🌦️'],
  [/大雨|暴雨|降雨/i, '🌧️'],
  [/雾|霾/i, '🌫️'],
  [/大风|狂风|风/i, '🌬️'],
  [/多云/i, '⛅'],
  [/阴天|阴/i, '☁️'],
  [/晴|阳光|晴朗/i, '☀️'],
]

export function weatherEmoji(weather?: string): string {
  const w = (weather || '').trim()
  if (!w || /未知|不详/i.test(w)) return ''
  for (const [re, emoji] of WEATHER_MAP) {
    if (re.test(w)) return emoji
  }
  return ''
}

// 预设天气（含“未知天气”），自定义天气若匹配不到上面的图标则不会显示图标。
export const WEATHER_PRESETS = [
  '晴朗',
  '多云',
  '阴天',
  '小雨',
  '大雨',
  '雷雨',
  '暴雨',
  '下雪',
  '大雾',
  '大风',
  '冰雹',
  '未知天气',
]

export function isPresetWeather(w: string): boolean {
  return WEATHER_PRESETS.includes((w || '').trim())
}

export function parseClock(iso: string): { date: string; time: string } {
  if (!iso) return { date: '—', time: '—' }
  const s = String(iso).trim()
  const pad = (n: number) => String(n).padStart(2, '0')
  // 若有 4 位年份，前缀必须是年份之前的部分，避免把“2026”的“20”误当成年份前缀。
  const yearMatch = s.match(/(?:^|[^\d])(19|20)\d{2}/)
  if (yearMatch && yearMatch.index != null) {
    const yearStart = yearMatch.index + (yearMatch[0].length > 4 ? 1 : 0)
    let prefix = ''
    if (yearStart > 0) prefix = s.slice(0, yearStart).replace(/[，。、\s]+$/g, '')
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) {
      return {
        date: `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`,
        time: `${prefix ? prefix + ' ' : ''}${pad(d.getHours())}:${pad(d.getMinutes())}`,
      }
    }
  }
  // 提取自定义时间前面的“不可解析前缀”（如 世界标准时 / 基沃托斯时间），用于原样展示。
  const ym = s.match(/(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/)
  const hm = s.match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?/)
  let prefix = ''
  const yIdx = ym ? ym.index ?? -1 : -1
  const hIdx = hm ? hm.index ?? -1 : -1
  const first = (yIdx >= 0 && hIdx >= 0) ? Math.min(yIdx, hIdx) : (yIdx >= 0 ? yIdx : hIdx)
  if (first > 0) prefix = s.slice(0, first).replace(/[，。、\s]+$/g, '')
  // 只有字符串里明确出现“年份”才用 Date 解析，避免 `new Date('07/20')` 冒出 2001 幽灵年份。
  const hasYear = /(?:^|[^\d])(19|20)\d{2}(?:[^\d]|$)/.test(s) || /^\d{4}[-/]/.test(s)
  if (hasYear) {
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) {
      return {
        date: `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`,
        time: `${prefix ? prefix + ' ' : ''}${pad(d.getHours())}:${pad(d.getMinutes())}`,
      }
    }
  }
  // 没有年份：只解析“月/日”与“时:分”，绝不补年份。
  const date = ym ? `${pad(+ym[1])}/${pad(+ym[2])}` : ''
  const time = hm ? `${pad(+hm[1])}:${pad(+(hm[2] || '0'))}` : ''
  if (time) return { date, time: `${prefix ? prefix + ' ' : ''}${time}` }
  if (date) return { date, time: prefix || s }
  return { date: '', time: s }
}

/** 尝试把自定义时间字符串规范成可读形式；ok=true 表示识别成功（可用于显示“格式化成功”标记）。 */
export function formatCustomTime(input?: string): { ok: boolean; display: string; raw: string } {
  const s = (input ?? '').trim()
  if (!s) return { ok: false, display: '', raw: s }
  const pad = (n: number) => String(n).padStart(2, '0')
  // 标准 ISO / 可解析日期 → YYYY-MM-DD HH:MM（去掉秒与时区）
  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) {
    return {
      ok: true,
      display: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      raw: s,
    }
  }
  // 中文类：X年[X月[X日]][[上/下]午][H[点][M分]]
  const zh = s.match(/^(\d{1,4})\s*年\s*(?:(\d{1,2})\s*月)?\s*(?:(\d{1,2})\s*[日号])?\s*([上下午]?\s*\d{1,2}\s*[点时])?\s*(\d{1,2}\s*分)?$/)
  if (zh) {
    const [, y, mo, da, hm, mi] = zh
    if (mo && (+mo < 1 || +mo > 12)) return { ok: false, display: s, raw: s }
    if (da && (+da < 1 || +da > 31)) return { ok: false, display: s, raw: s }
    let out = ''
    if (mo || da) out += `${y}年${mo ? mo + '月' : ''}${da ? da + '日' : ''}`
    else out += `${y}年`
    if (hm) out += ` ${hm.replace(/\s/g, '')}${mi ? mi.replace(/\s/g, '') : ''}`
    return { ok: true, display: out.trim() || s, raw: s }
  }
  // 无年：M/D H:MM 或 M月D日 H:MM（或 M/D/HH:MM）
  const day = s.match(/^(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?\s*[-/]?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?$/)
  if (day) {
    const m = (+day[1]), dd = (+day[2]), h = (+day[3]), mi = (+(day[4] || '0'))
    if (m < 1 || m > 12 || dd < 1 || dd > 31 || h > 23 || mi > 59) return { ok: false, display: s, raw: s }
    const amp = s.includes('下午') || s.includes('晚上')
    const hh = amp && h < 12 ? h + 12 : h
    return { ok: true, display: `${m}/${dd} ${pad(hh)}:${pad(mi)}`, raw: s }
  }
  // 前缀 + 日期 + 时间：如 世界标准时 7/16/5:00（前缀原样保留，日期/时间解析并推进）
  const prefDay = s.match(/^(.*?)(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?\s*[-/]?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?$/)
  if (prefDay) {
    const prefix = prefDay[1].trim()
    const m = (+prefDay[2]), dd = (+prefDay[3]), h = (+prefDay[4]), mi = (+(prefDay[5] || '0'))
    if (m < 1 || m > 12 || dd < 1 || dd > 31 || h > 23 || mi > 59) return { ok: false, display: s, raw: s }
    const amp = s.includes('下午') || s.includes('晚上')
    const hh = amp && h < 12 ? h + 12 : h
    const display = `${prefix ? prefix + ' ' : ''}${m}/${dd} ${pad(hh)}:${pad(mi)}`
    return { ok: true, display, raw: s }
  }
  // 无日期、仅时间：H:MM（含前缀则保留前缀）
  const onlyTime = s.match(/^(.*?)(\d{1,2})\s*[:：点时]\s*(\d{1,2})\s*分?$/)
  if (onlyTime) {
    const prefix = onlyTime[1].trim()
    const h = (+onlyTime[2]), mi = (+onlyTime[3])
    return { ok: true, display: `${prefix}${pad(h)}:${pad(mi)}`, raw: s }
  }
  // 兜底：能提取到 年 月 日 三个数字 → 当作日期
  const nums = s.match(/\d+/g)
  if (nums && nums.length >= 3) {
    const y = +nums[0], mo = +nums[1], dd = +nums[2]
    if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      return { ok: true, display: `${y}年${mo}月${dd}日`, raw: s }
    }
    return { ok: false, display: s, raw: s }
  }
  return { ok: false, display: s, raw: s }
}

export function normalizeSpeech(text: string): string {
  return (text || '').replace(/^「|」$/g, '').replace(/^「|」$/g, '')
}

export function normalizeAction(text: string): string {
  return (text || '').replace(/^\*|\*$/g, '').replace(/^\*|\*$/g, '')
}

/** 把头像字段（可能是裸 base64，也可能是 data: URL）规范成一个可直接给 <img> 的 src。 */
export function avatarUrl(avatar?: string): string {
  if (!avatar) return ''
  const s = avatar.trim()
  if (!s) return ''
  if (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://')) return s
  let mime = 'image/webp'
  if (s.startsWith('/9j')) mime = 'image/jpeg'
  else if (s.startsWith('iVBOR')) mime = 'image/png'
  else if (s.startsWith('R0lGOD')) mime = 'image/gif'
  return `data:${mime};base64,${s}`
}
