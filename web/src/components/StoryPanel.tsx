import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useApp } from '@/store/appStore'
import { useToast } from '@/store/toastStore'
import type { LogEntry, PlayerSegment } from '@/types'
import { useRenderPrefs, styleOf } from '@/store/renderPrefs'
import { useTheme } from '@/store/theme'
import { useNameDisplay, displayNameFor } from '@/store/nameDisplay'
import { editHistory, editStoryHistory, deleteHistory, branchHistory, createSnapshotFromHistory } from '@/lib/api'
import {
  parseClock,
  normalizeSpeech,
  normalizeAction,
  avatarUrl,
} from '@/lib/format'

function stripSegMarkers(type: string, text: string): string {
  let t = (text || '').trim()
  if (type === 'action') t = t.replace(/^\*+|\*+$/g, '')
  else t = t.replace(/^「+|」+$/g, '')
  return t
    .replace(/\*{2,}/g, '*')
    .replace(/「{2,}/g, '「')
    .replace(/」{2,}/g, '」')
    .trim()
}

function messageText(entry: LogEntry): string {
  if (entry.kind === 'story') return entry.text
  if (entry.kind === 'player') return entry.text
  if (entry.kind === 'character') {
    return entry.sequence
      .filter((s) => s.text.trim())
      .map((s) => (s.type === 'action' ? `*${stripSegMarkers('action', s.text)}*` : `「${stripSegMarkers('speech', s.text)}」`))
      .join(' ')
      .trim()
  }
  if (entry.kind === 'scene') return entry.text
  return ''
}

function isRenderable(entry: LogEntry): boolean {
  if (entry.kind === 'story') {
    return Boolean((entry.text || '').trim())
  }
  if (entry.kind === 'character') {
    return Boolean(entry.thought?.trim()) || entry.sequence.some((s) => s.text.trim())
  }
  if (entry.kind === 'player' && entry.segments) {
    return entry.segments.some((s) => s.text.trim())
  }
  return true
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parsePlayerSegments(text: string, playerName?: string): PlayerSegment[] | undefined {
  const trimmed = (text || '').trim()
  if (!trimmed) return undefined
  const name = (playerName || '').trim()
  const namePat = name ? `${escapeRe(name)}|老师` : '老师'
  if (!new RegExp(`(?:${namePat}\\s*)?(说道|做了)[：:「]`).test(trimmed)) return undefined
  const re = new RegExp(
    `(?:${namePat}\\s*)?(说道|做了)[：:「]*([\\s\\S]*?)(?=(?:${namePat}\\s*)?(说道|做了)[：:「]*|$)`,
    'g',
  )
  const segs: PlayerSegment[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed))) {
    const kindRaw = m[1]
    const kind: PlayerSegment['type'] = kindRaw === '说道' ? 'speech' : 'action'
    const body = m[2].trim().replace(/^「|」$/g, '').replace(/^「|」$/g, '').trim()
    if (body) segs.push({ type: kind, text: body })
  }
  return segs.length ? segs : undefined
}

/** 把小说式剧情文本按 *动作* 与 「说话」 拆开，剩余部分作为叙述文本，供精确模式式渲染。 */
function parseStorySegments(text: string): { type: 'text' | 'action' | 'speech'; text: string }[] {
  const raw = (text || '').trim()
  if (!raw) return []
  const out: { type: 'text' | 'action' | 'speech'; text: string }[] = []
  const re = /[*]+([^*]+)[*]+|「+([^」]+)」+/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    if (m.index > last) {
      const t = raw.slice(last, m.index).trim()
      if (t) out.push({ type: 'text', text: t })
    }
    if (m[1] != null) {
      const t = m[1].trim()
      if (t) out.push({ type: 'action', text: t })
    } else if (m[2] != null) {
      const t = m[2].trim()
      if (t) out.push({ type: 'speech', text: t })
    }
    last = re.lastIndex
  }
  if (last < raw.length) {
    const t = raw.slice(last).trim()
    if (t) out.push({ type: 'text', text: t })
  }
  return out
}

/** 把世界的“时间字符串”渲染成历史时间标注：可解析则带 上午/下午 + 日期，否则保留原标签。 */
function formatTimeMarker(input?: string): string {
  const s = (input ?? '').trim()
  if (!s) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  // 带中文标签（如“世界标准时/基沃托斯时间”）且不含 年/月/日 的：原样显示，保留标签。
  if (/[\u4e00-\u9fa5]/.test(s) && !/[年月日]/.test(s)) {
    return s
  }
  const c = parseClock(s)
  let time = c.time || s
  const hm = time.match(/(\d{1,2}):(\d{2})/)
  if (hm) {
    const h = parseInt(hm[1], 10)
    const m = parseInt(hm[2], 10)
    const pm = h >= 12
    const prefix = time.slice(0, hm.index)
    time = `${prefix}${pm ? '下午' : '上午'}${h % 12 || 12}:${pad(m)}`
  }
  return c.date ? `${c.date} ${time}` : time
}

function findHistoryIndex(entry: LogEntry, history: string[]): number {
  // structured_history 的 sceneIndex 已由后端相对 scene_window 重定位；绝对索引 = 相对 + scene_start。
  const sceneStart = useApp.getState().appState?.scene_start ?? 0
  const mapAbs = (winIdx: number) => (winIdx >= 0 ? winIdx + sceneStart : winIdx)
  const sceneIndex = (entry as { sceneIndex?: number }).sceneIndex
  if (sceneIndex != null) {
    // 校验该索引是否真的指向这条消息：旧数据里玩家消息的 sceneIndex 可能误指向最后一行角色。
    if (sceneIndex >= 0 && sceneIndex < history.length) {
      const line = history[sceneIndex]
      const needle = messageText(entry).trim()
      if (entry.kind === 'story') {
        if (line.trim() === `[剧情总结] ${needle}` || (needle && line.includes(needle))) {
          return mapAbs(sceneIndex)
        }
      } else {
        const name = entry.kind === 'character' || entry.kind === 'player' || entry.kind === 'scene' ? entry.name : ''
        if (name) {
          // 名字匹配即可接受（该行确属同名者），避免文本微调后找不到行导致“存点/删除/编辑”失效。
          if (line.trim().startsWith(`[${name}]`)) {
            return mapAbs(sceneIndex)
          }
        } else if (line.trim() === needle) {
          return mapAbs(sceneIndex)
        }
      }
    }
    // 不匹配则走下方按名字/整行的精确匹配兜底。
  }
  const name = entry.kind === 'character' || entry.kind === 'player' || entry.kind === 'scene' ? entry.name : ''
  const needle = messageText(entry).trim()
  if (!name) {
    // 无名字的场景（背景/旁白）：直接匹配整行。
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].trim() === needle) return mapAbs(i)
    }
    const p0 = needle.slice(0, 20)
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].includes(p0)) return mapAbs(i)
    }
    return -1
  }
  const prefix = `[${name}]`
  const exact = `${prefix} ${needle}`
  // 优先精确匹配整行，避免重复内容/重写后匹配到错误的一行。
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].trim() === exact) return mapAbs(i)
  }
  const probe = needle.slice(0, 20)
  for (let i = history.length - 1; i >= 0; i--) {
    const line = history[i]
    if (line.startsWith(prefix) && (!probe || line.includes(probe))) return mapAbs(i)
  }
  return -1
}

function WorldCard({ entry }: { entry: Extract<LogEntry, { kind: 'world_update' }> }) {
  return (
    <Card className="my-2 border-primary/20 bg-primary/5">
      <CardContent className="px-4 py-3 text-sm">
        <p className="mb-1 font-semibold text-primary">🌍 世界更新</p>
        {entry.changes.length === 0 ? (
          <p className="text-muted-foreground">本时间段没有值得记录的显著变化。</p>
        ) : (
          <ul className="space-y-0.5">
            {entry.changes.map((c, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{parseClock(c.time).time}</span>
                <span className="mx-1">{c.place}</span>
                <span>{c.description}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function CharacterBubble({ entry }: { entry: Extract<LogEntry, { kind: 'character' }> }) {
  const showThought = useApp((s) => s.appState?.show_thought)
  const prefs = useRenderPrefs()
  const bubbleDelay = useRenderPrefs((s) => s.bubbleDelayMs)
  const isDark = useTheme((s) => s.theme === 'dark')
  const showSurname = useNameDisplay((s) => s.showSurname)
  const char = useApp((s) => s.appState?.characters?.find((c) => c.id === entry.character))
  const avatar = char?.avatar
  const dispName = displayNameFor(entry.name, char?.surname, showSurname)
  if (!entry.thought?.trim() && !entry.sequence.some((s) => s.text.trim())) return null
  const avatarSrc = avatarUrl(avatar)
  return (
    <div className="flex gap-2">
      <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-base font-bold text-white">
        {avatarSrc ? <img src={avatarSrc} alt={dispName} className="h-full w-full object-cover" /> : dispName.slice(0, 1)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-sm font-semibold text-violet-700 dark:text-violet-300">{dispName}</div>
        {showThought && entry.thought && (
          <div className="mb-1.5 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-sm italic text-muted-foreground">
            💭 {entry.thought}
          </div>
        )}
        <div className="space-y-1">
          {entry.sequence.filter((s) => (s.text || '').trim()).map((seg, i) =>
            seg.type === 'action' ? (
              <div key={i} className="bubble-in max-w-full break-words text-[15px]" style={{ ...styleOf('action', prefs, isDark), animationDelay: `${i * bubbleDelay}ms` }}>
                {normalizeAction(seg.text)}
              </div>
            ) : (
              <div
                key={i}
                className="bubble-in inline-block max-w-full break-words rounded-2xl rounded-tl-sm bg-card px-4 py-2 text-[15px] shadow-sm"
                style={{ ...styleOf('speech', prefs, isDark), animationDelay: `${i * bubbleDelay}ms` }}
              >
                {normalizeSpeech(seg.text)}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  )
}

function PlayerPrecise({ entry }: { entry: Extract<LogEntry, { kind: 'player' }> }) {
  const prefs = useRenderPrefs()
  const isDark = useTheme((s) => s.theme === 'dark')
  const segments = entry.segments ?? []
  return (
    <div className="flex flex-col items-end gap-1.5">
      {segments.filter((s) => (s.text || '').trim()).map((seg, i) => {
        const style = styleOf(seg.type, prefs, isDark)
        if (seg.type === 'action') {
          return (
            <div key={i} className="max-w-[82%] text-[15px]" style={style}>
              {normalizeAction(seg.text)}
            </div>
          )
        }
        if (seg.type === 'think') {
          return (
            <div key={i} className="max-w-[82%] rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-[15px]" style={style}>
              <span className="mr-1.5 text-xs opacity-70">💭</span>
              {seg.text}
            </div>
          )
        }
        return (
          <div key={i} className="max-w-[82%] rounded-2xl rounded-tr-sm bg-card px-4 py-2 text-[15px] shadow-sm" style={style}>
            {normalizeSpeech(seg.text)}
          </div>
        )
      })}
    </div>
  )
}

function EntryView({ entry }: { entry: LogEntry }) {
  const playerName = useApp((s) => s.appState?.user_identity?.name)
  if (entry.kind === 'story') {
    const prefs = useRenderPrefs()
    const isDark = useTheme((s) => s.theme === 'dark')
    const segs = parseStorySegments(entry.text)
    return (
      <div className="mx-1 my-1 overflow-hidden rounded-2xl border border-border/60 bg-card/30">
        <div className="px-3 py-1 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
          📖 剧情总结
        </div>
        <div className="space-y-1.5 px-3 pb-2">
          {segs.map((s, i) => {
            if (s.type === 'action') {
              return (
                <div key={i} className="bubble-in text-[15px] italic leading-relaxed" style={styleOf('action', prefs, isDark)}>
                  {normalizeAction(s.text)}
                </div>
              )
            }
            if (s.type === 'speech') {
              return (
                <div
                  key={i}
                  className="bubble-in inline-block max-w-full break-words rounded-2xl rounded-tl-sm bg-card px-4 py-2 text-[15px] shadow-sm"
                  style={styleOf('speech', prefs, isDark)}
                >
                  {normalizeSpeech(s.text)}
                </div>
              )
            }
            return (
              <div key={i} className="bubble-in whitespace-pre-wrap break-words text-[15px] leading-relaxed">
                {s.text}
              </div>
            )
          })}
        </div>
      </div>
    )
  }
  if (entry.kind === 'player') {
    const segs = entry.segments && entry.segments.length ? entry.segments : parsePlayerSegments(entry.text, playerName)
    if (segs && segs.length) {
      return <PlayerPrecise entry={{ ...entry, segments: segs } as Extract<LogEntry, { kind: 'player' }>} />
    }
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2 text-[15px] text-primary-foreground shadow md:max-w-[78%]">
          {entry.text}
        </div>
      </div>
    )
  }
  if (entry.kind === 'character') return <CharacterBubble entry={entry} />
  // 环境感知信息不在故事区重复显示，而是由左侧环境面板负责（含 NEW! 角标）。
  if (entry.kind === 'environment') return null
  if (entry.kind === 'scene') {
    return (
      <div className="flex gap-2 text-[15px]">
        {entry.name && <span className="shrink-0 text-sm text-violet-700 dark:text-violet-300">[{entry.name}]</span>}
        <span className="min-w-0">{entry.text}</span>
      </div>
    )
  }
  if (entry.kind === 'world_update') return <WorldCard entry={entry} />
  if (entry.kind === 'character_update') {
    return (
      <div className="my-2 text-center text-xs text-muted-foreground">
        🔄 已更新角色：{entry.updated.join('、') || '无'}
      </div>
    )
  }
  if (entry.kind === 'memory_summary') {
    return <div className="my-1 text-center text-xs text-muted-foreground">💭 {entry.detail}</div>
  }
  if (entry.kind === 'forget') {
    return (
      <div className="my-1 text-center text-xs text-muted-foreground">
        🗑️ {entry.character} 已执行容量遗忘，当前 {entry.event_count} 个事件。
      </div>
    )
  }
  if (entry.kind === 'hint') {
    return (
      <div className="my-1 flex justify-center">
        <div className="max-w-[94%] whitespace-pre-wrap break-words rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-center text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          🔔 {entry.text}
        </div>
      </div>
    )
  }
  // system / error
  return <div className="my-1 text-center text-[11px] text-muted-foreground">{entry.text}</div>
}

function MessageActions({
  entry,
  onEdit,
  onDelete,
  onBranch,
  onSave,
}: {
  entry: LogEntry
  onEdit: (entry: LogEntry) => void
  onDelete: (entry: LogEntry) => void
  onBranch: (entry: LogEntry) => void
  onSave: (entry: LogEntry) => void
}) {
  const canAct = entry.kind === 'player' || entry.kind === 'story' || entry.kind === 'character' || entry.kind === 'scene'
  if (!canAct) return null
  return (
    <div className="mb-0.5 flex shrink-0 justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">
      <Button size="xs" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground max-md:h-9 max-md:px-3" onClick={() => onEdit(entry)}>
        编辑
      </Button>
      <Button size="xs" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground max-md:h-9 max-md:px-3" onClick={() => onDelete(entry)}>
        删除
      </Button>
      <Button size="xs" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground max-md:h-9 max-md:px-3" onClick={() => onSave(entry)}>
        存点
      </Button>
      <Button size="xs" variant="ghost" className="h-6 px-2 text-xs text-amber-700 dark:text-amber-300/80 max-md:h-9 max-md:px-3" onClick={() => onBranch(entry)}>
        从此开始
      </Button>
    </div>
  )
}

export default function StoryPanel() {
  const log = useApp((s) => s.log)
  const streaming = useApp((s) => s.streaming)
  const typing = useApp((s) => s.typing)
  const statusMsg = useApp((s) => s.statusMsg)
  const bgUpdateStatus = useApp((s) => s.appState?.background_update_status || '')
  const nameDisp = useNameDisplay()
  const showSurname = nameDisp.showSurname
  const toast = useToast()
  const [editing, setEditing] = useState<LogEntry | null>(null)
  const [editText, setEditText] = useState('')
  const [storyEditing, setStoryEditing] = useState<{ sceneIndex: number; text: string; directive: string } | null>(null)
  const [dayFilter, setDayFilter] = useState<string | null>(null)
  const [dayMenuOpen, setDayMenuOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  const dayKey = (ts?: number) => (ts == null ? '' : new Date(ts * 1000).toISOString().slice(0, 10))
  const dayInfo = useMemo(() => {
    const order: string[] = []
    const seen = new Set<string>()
    let hasLegacy = false
    for (const e of log) {
      if (e.ts == null) { hasLegacy = true; continue }
      const d = dayKey(e.ts)
      if (!seen.has(d)) { seen.add(d); order.push(d) }
    }
    order.sort((a, b) => (a < b ? 1 : -1))
    return { order, hasLegacy }
  }, [log])
  const latestDay = dayInfo.order[0] ?? null
  const effectiveDay = dayFilter === 'all' ? 'all' : (dayFilter ?? (latestDay ?? 'legacy'))
  const visibleLog = log
    .filter((e) => {
      if (effectiveDay === 'all') return true
      if (e.ts == null) return true          // 未分类/旧数据/临时系统消息：始终显示，避免“发送后不显示”
      if (effectiveDay === 'legacy') return false
      return dayKey(e.ts) === effectiveDay
    })
    .filter(isRenderable)
  const typingSurname = typing?.character
    ? useApp.getState().appState?.characters?.find((c) => c.id === typing.character)?.surname
    : undefined

  const history = useApp((s) => s.appState?.scene_history ?? [])

  const reload = async () => {
    await useApp.getState().loadSession()
  }

  const onEdit = (entry: LogEntry) => {
    if (entry.kind === 'story') {
      const idx = findHistoryIndex(entry, history)
      if (idx >= 0) {
        setStoryEditing({ sceneIndex: idx, text: entry.text, directive: entry.directive ?? '' })
      }
      return
    }
    setEditing(entry)
    setEditText(messageText(entry))
  }

  const onDelete = async (entry: LogEntry) => {
    const idx = findHistoryIndex(entry, history)
    if (idx < 0) {
      toast.push('删除失败', '未找到对应的历史条目', 'error')
      return
    }
    if (!window.confirm('确定删除这条消息？')) return
    await deleteHistory(idx)
    await reload()
    toast.push('已删除消息', '', 'success')
  }

  const onBranch = async (entry: LogEntry) => {
    const idx = findHistoryIndex(entry, history)
    if (idx < 0) {
      toast.push('重开失败', '未找到对应的历史条目', 'error')
      return
    }
    if (!window.confirm('从这条消息之后重新开始？\n世界状态不会回溯。')) return
    await branchHistory(idx)
    await reload()
    toast.push('已从此处重新开始', '历史已裁剪，世界状态保持不变', 'success')
  }

  const onSave = async (entry: LogEntry) => {
    const idx = findHistoryIndex(entry, history)
    if (idx < 0) {
      toast.push('保存存档点失败', '未找到对应的历史条目', 'error')
      return
    }
    await createSnapshotFromHistory(idx)
    toast.push('已创建存档点', '可从消息操作或存档面板从此处回溯', 'success')
  }

  const saveEdit = async () => {
    if (!editing) return
    const idx = findHistoryIndex(editing, history)
    if (idx < 0) {
      toast.push('编辑失败', '未找到对应的历史条目', 'error')
      return
    }
    let name = ''
    if (editing.kind === 'player' || editing.kind === 'character' || editing.kind === 'scene') name = editing.name
    const line = editing.kind === 'scene' && !editing.name
      ? editText.trim()
      : `[${name}] ${editText.trim()}`
    const r = await editHistory(idx, line)
    setEditing(null)
    // 双保险：先应用接口返回的最新状态，再从服务器重拉一次，确保显示与上下文一致。
    if (r.state) useApp.getState().applyState(r.state)
    await useApp.getState().loadSession()
    toast.push('已更新消息', '', 'success')
  }

  const saveStoryEdit = async () => {
    if (!storyEditing) return
    const r = await editStoryHistory(storyEditing.sceneIndex, {
      text: storyEditing.text,
      directive: storyEditing.directive,
    })
    setStoryEditing(null)
    if (r.state) useApp.getState().applyState(r.state)
    await useApp.getState().loadSession()
    toast.push('已更新剧情', '', 'success')
  }

  // 智能滚动：只有用户本来就停在底部时才自动滚到底；在看上方旧消息时不打断。
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !atBottomRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [log.length, streaming])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overflow-x-hidden px-3 pb-3 pt-1.5 md:px-4 md:pb-4 md:pt-2">
      <div className="sticky top-2 z-10 mb-1 flex justify-end">
        <div className="relative">
          <button
            type="button"
            className="flex items-center gap-1 rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
            onClick={() => setDayMenuOpen((v) => !v)}
            title="按天查看历史"
          >
            <span>{effectiveDay === 'all' ? '全部' : effectiveDay === 'legacy' ? '更早' : effectiveDay}</span>
            <span className="text-[9px]">▾</span>
          </button>
          {dayMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-lg border border-border/60 bg-popover p-1 shadow-xl">
              {(latestDay ?? null) && (
                <button type="button" className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted/50"
                  onClick={() => { setDayFilter(latestDay); setDayMenuOpen(false) }}>
                  {latestDay}（最新）
                </button>
              )}
              {dayInfo.order.map((d) => (
                <button key={d} type="button" className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted/50"
                  onClick={() => { setDayFilter(d); setDayMenuOpen(false) }}>
                  {d}
                </button>
              ))}
              {dayInfo.hasLegacy && (
                <button type="button" className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted/50"
                  onClick={() => { setDayFilter('legacy'); setDayMenuOpen(false) }}>
                  更早（无时间标记）
                </button>
              )}
              <button type="button" className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted/50"
                onClick={() => { setDayFilter('all'); setDayMenuOpen(false) }}>
                全部
              </button>
            </div>
          )}
        </div>
      </div>
      {visibleLog.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center text-center">
          <div className="text-6xl">✨</div>
          <p className="mt-4 text-base text-muted-foreground">世界尚未开始，在下方输入你的想法吧。</p>
        </div>
      )}
      <div className="space-y-3">
        {visibleLog.map((entry, i) => {
          const prev = i > 0 ? visibleLog[i - 1] : null
          const showMarker = Boolean(entry.ptime) && (!prev || prev.ptime !== entry.ptime)
          return (
            <Fragment key={entry.id}>
              {showMarker && (
                <div className="mb-1 mt-2 flex justify-center">
                  <span className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                    {formatTimeMarker(entry.ptime)}
                  </span>
                </div>
              )}
              <motion.div
                className="group relative"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <MessageActions entry={entry} onEdit={onEdit} onDelete={onDelete} onBranch={onBranch} onSave={onSave} />
                <EntryView entry={entry} />
              </motion.div>
            </Fragment>
          )
        })}
        {streaming && (
          <div className="space-y-2 pl-10">
            {typing?.text !== undefined && !(typing.text.length === 0 && streaming) && (
              <div className="flex gap-2">
                <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-base font-bold text-white">
                  {displayNameFor(typing.name, typingSurname, showSurname).slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-sm font-semibold text-violet-700 dark:text-violet-300">{displayNameFor(typing.name, typingSurname, showSurname)}</div>
                  <div className="inline-block max-w-full max-h-40 overflow-hidden whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-card px-4 py-2 text-[15px] shadow-sm">
                    {typing.text || '…'}
                    <span className="typing-caret">▍</span>
                  </div>
                </div>
              </div>
            )}
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}
      </div>
      {statusMsg && streaming && (
        <div className="sticky bottom-2 mt-2 text-center text-sm text-violet-700 dark:text-violet-300">{statusMsg}</div>
      )}
      {bgUpdateStatus && (
        <div className="sticky bottom-2 mt-2 flex items-center justify-center gap-1.5 text-xs text-amber-600 dark:text-amber-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          {bgUpdateStatus}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑消息</DialogTitle>
          </DialogHeader>
          <Textarea className="min-h-32 max-h-[45vh] resize-none overflow-y-auto text-base" value={editText} onChange={(e) => setEditText(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            <Button onClick={saveEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!storyEditing} onOpenChange={(o) => !o && setStoryEditing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>编辑剧情总结</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">剧情文本</div>
              <Textarea
                className="min-h-40 max-h-[40vh] resize-none overflow-y-auto text-base"
                value={storyEditing?.text ?? ''}
                onChange={(e) => setStoryEditing((s) => s ? { ...s, text: e.target.value } : s)}
              />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">本回合剧情指令（重写会遵循它）</div>
              <Textarea
                className="min-h-16 max-h-[18vh] resize-none overflow-y-auto text-sm"
                value={storyEditing?.directive ?? ''}
                onChange={(e) => setStoryEditing((s) => s ? { ...s, directive: e.target.value } : s)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStoryEditing(null)}>取消</Button>
            <Button onClick={saveStoryEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
