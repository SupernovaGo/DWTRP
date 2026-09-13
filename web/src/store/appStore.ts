import { create } from 'zustand'
import {
  fetchState,
  sendChat,
  streamChat,
  streamRewind,
  streamManualUpdate,
  ackPendingUpdates,
  setThink,
  setStoryMode,
  resetSession,
} from '@/lib/api'
import type { AppState, LogEntry, PlayerSegment, SequenceSegment, SSEEvent, TimelineEvent } from '@/types'
import { useToast } from '@/store/toastStore'
import { useNotices } from '@/store/noticeStore'
import { isApiKeyMissing } from '@/store/apiKeyStore'
import { useShell } from '@/store/useShell'

let counter = 0
const nextId = () => `m${++counter}`
let updatePollTimer: ReturnType<typeof setInterval> | null = null

function parseSceneHistory(lines: string[]): LogEntry[] {
  const out: LogEntry[] = []
  for (let i = 0; i < (lines || []).length; i++) {
    const raw = lines[i]
    const m = raw.match(/^\[([^\]]+)\]\s*([\s\S]*)$/)
    if (m) {
      out.push({ id: nextId(), kind: 'scene', name: m[1], text: m[2], sceneIndex: i })
    } else if (raw.trim()) {
      out.push({ id: nextId(), kind: 'scene', name: '', text: raw, sceneIndex: i })
    }
  }
  return out
}

function entryFromEvent(ev: SSEEvent): LogEntry | null {
  let out: LogEntry | null = null
  switch (ev.type) {
    case 'player':
      out = {
        id: nextId(),
        kind: 'player',
        name: ev.name as string,
        text: ev.text as string,
        segments: Array.isArray(ev.segments) ? (ev.segments as PlayerSegment[]) : undefined,
        sceneIndex: (ev as any).sceneIndex as number | undefined,
      }
      break
    case 'story':
      out = {
        id: nextId(),
        kind: 'story',
        text: ev.text as string,
        directive: ev.directive as string | undefined,
        sceneIndex: (ev as any).sceneIndex as number | undefined,
      }
      break
    case 'scene':
      out = {
        id: nextId(),
        kind: 'scene',
        name: (ev.name as string) || '',
        text: ev.text as string,
        sceneIndex: (ev as any).sceneIndex as number | undefined,
      }
      break
    case 'environment':
      out = {
        id: nextId(),
        kind: 'environment',
        perception: (ev.perception ?? {}) as Partial<AppState['perception']>,
        changed: (ev.changed ?? []) as string[],
      }
      break
    case 'character':
      out = {
        id: nextId(),
        kind: 'character',
        name: ev.name as string,
        character: ev.character as string,
        thought: (ev.thought as string) || '',
        sequence: (ev.sequence ?? []) as SequenceSegment[],
        silent: Boolean(ev.silent),
        sceneIndex: (ev as any).sceneIndex as number | undefined,
      }
      break
    case 'hint':
      out = { id: nextId(), kind: 'hint', text: ev.text as string }
      break
    case 'system':
      out = { id: nextId(), kind: 'system', text: ev.text as string }
      break
    case 'world_update':
      out = {
        id: nextId(),
        kind: 'world_update',
        changes: (ev.changes ?? []) as TimelineEvent[],
        rendered: (ev.rendered as string) || '',
      }
      break
    case 'character_update':
      out = {
        id: nextId(),
        kind: 'character_update',
        updated: (ev.updated ?? []) as string[],
      }
      break
    case 'memory_summary':
      out = {
        id: nextId(),
        kind: 'memory_summary',
        character: ev.character as string,
        detail: ev.detail as string,
      }
      break
    case 'forget':
      out = {
        id: nextId(),
        kind: 'forget',
        character: ev.character as string,
        event_count: ev.event_count as number,
      }
      break
    case 'error':
      out = { id: nextId(), kind: 'system', text: `出错了：${ev.text}` }
      break
    default:
      return null
  }
  if (out && ev.ts != null) {
    ;(out as unknown as { ts?: number }).ts = ev.ts as number
  }
  if (out && ev.ptime != null) {
    ;(out as unknown as { ptime?: string }).ptime = ev.ptime as string
  }
  return out
}

function buildLog(state: AppState): LogEntry[] {
  if (state.structured_history && state.structured_history.length) {
    const out: LogEntry[] = []
    for (const ev of state.structured_history) {
      const e = entryFromEvent(ev as SSEEvent)
      if (e) out.push(e)
    }
    return out
  }
  return parseSceneHistory(state.scene_history)
}

// ---------- 后台更新通知 ----------
function noticeEntry(ev: SSEEvent): { title: string; msg: string } | null {
  switch (ev.type) {
    case 'world_update':
      return { title: '🌍 世界更新', msg: (ev.rendered as string) || '世界已更新' }
    case 'character_update': {
      const names = (ev.updated as string[]) || []
      return { title: '🎭 角色更新', msg: names.length ? `已更新：${names.join('、')}` : '角色状态已更新' }
    }
    case 'memory_summary':
      return { title: '💭 记忆总结', msg: (ev.detail as string) || '' }
    case 'forget':
      return { title: '🧹 记忆遗忘', msg: `${ev.character} 已遗忘部分记忆` }
    default:
      return null
  }
}

function isQuietProcessing(text: string): boolean {
  // “正在理解/正在回应”是回合关键提示；总结/更新/整理属于可关闭的后台提示。
  return /总结|更新|整理/.test(text)
}

function showPendingUpdates(state: AppState) {
  const arr = state.pending_updates || []
  if (!arr.length) return
  const show = useNotices.getState().showNotices
  if (show) {
    for (const ev of arr as SSEEvent[]) {
      const inf = noticeEntry(ev)
      if (inf) useToast.getState().push(inf.title, inf.msg, 'info')
    }
  }
  ackPendingUpdates().catch(() => {})
  // 消费后立即清空本地 pending_updates，避免后续轮询重复弹提示。
  useApp.setState((s) => (s.appState ? { appState: { ...s.appState, pending_updates: [] } } : {}))
}

function maybeStartUpdatePoll(state: AppState) {
  if (state.background_update_active) {
    if (updatePollTimer) return
    updatePollTimer = setInterval(async () => {
      try {
        const st = await fetchState()
        useApp.getState().applyPollState(st)
        showPendingUpdates(st)
        if (!st.background_update_active) {
          clearInterval(updatePollTimer!)
          updatePollTimer = null
        }
      } catch {
        /* 忽略轮询期间的瞬时错误 */
      }
    }, 3000)
  } else if (updatePollTimer) {
    clearInterval(updatePollTimer)
    updatePollTimer = null
    showPendingUpdates(state)
  }
}

interface AppStore {
  appState: AppState | null
  log: LogEntry[]
  streaming: boolean
  connecting: boolean
  statusMsg: string | null
  typing: { character: string; name: string; text: string } | null
  init: () => Promise<void>
  refresh: () => Promise<void>
  loadSession: () => Promise<void>
  applyState: (state: AppState) => void
  applyPollState: (state: AppState) => void
  send: (text: string, segments?: PlayerSegment[]) => Promise<void>
  rewindLast: () => Promise<void>
  manualUpdate: (target: 'world' | 'character') => Promise<void>
  toggleThink: (value: boolean) => Promise<void>
  setStoryMode: (enabled: boolean) => Promise<void>
  reset: () => Promise<void>
}

export const useApp = create<AppStore>((set, get) => ({
  appState: null,
  log: [],
  streaming: false,
  connecting: false,
  statusMsg: null,
  typing: null,

  init: async () => {
    set({ connecting: true })
    try {
      const state = await fetchState()
      set({ appState: state, log: buildLog(state), connecting: false })
      maybeStartUpdatePoll(state)
    } catch (e) {
      // 无会话（409）或连接失败：进入空白状态，由前端引导新建/选择会话。
      set({ connecting: false, appState: null, log: [], statusMsg: null, typing: null })
    }
  },

  refresh: async () => {
    const state = await fetchState()
    set({ appState: state })
  },

  loadSession: async () => {
    const state = await fetchState()
    set({ appState: state, log: buildLog(state), streaming: false, statusMsg: null, typing: null })
    maybeStartUpdatePoll(state)
  },

  applyState: (state) => {
    set({ appState: state, log: buildLog(state), streaming: false, statusMsg: null, typing: null })
  },

  applyPollState: (state) => {
    // 轮询只刷新 appState（环境/世界/角色），不重建对话 log，避免打断当前渲染。
    set({ appState: state })
  },

  send: async (text, segments) => {
    const trimmed = text.trim()
    const precise = segments && segments.length > 0
    const playerName = get().appState?.user_identity?.name || '玩家'
    const storyMode = Boolean(get().appState?.story_mode)
    const payload = precise ? buildCombined(segments as PlayerSegment[], playerName) : trimmed
    if ((!storyMode && !payload) || get().streaming) return

    // 未配置 API Key：给出显式提醒并跳到设置页，不发起请求。
    if (isApiKeyMissing()) {
      useToast.getState().push(
        '未配置 DeepSeek API Key',
        '请先在「设置 → 连接 / 高级」里填写 API Key 后再对话',
        'error',
      )
      useShell.getState().openSettings('connection')
      return
    }

    if (!storyMode) {
      const player: LogEntry = { id: nextId(), kind: 'player', name: playerName, text: payload, segments: precise ? segments as PlayerSegment[] : undefined, ts: Date.now() / 1000 }
      set((s) => ({ log: [...s.log, player], streaming: true }))
    } else {
      set({ streaming: true })
    }

    const handle = (ev: SSEEvent) => {
      if (ev.type === 'turn_end') {
        const state = ev.state as AppState
        set(() => ({ appState: state, streaming: false, statusMsg: null, typing: null }))
        maybeStartUpdatePoll(state)
        return
      }
      if (ev.type === 'processing') {
        if (!useNotices.getState().showNotices && isQuietProcessing(ev.text as string)) return
        set(() => ({ statusMsg: ev.text as string }))
        return
      }
      if (ev.type === 'character_delta') {
        set(() => ({
          typing: {
            character: ev.character as string,
            name: ev.name as string,
            text: ev.text as string,
          },
        }))
        return
      }
      if (ev.type === 'error') {
        set((s) => ({
          streaming: false,
          statusMsg: null,
          log: [...s.log, { id: nextId(), kind: 'system', text: `对话失败：${ev.text}` }],
        }))
        return
      }
      // 记忆总结 / 世界/角色更新 / 遗忘：只做右上角临时提示，不写入对话历史。
      const notice = noticeEntry(ev)
      if (notice) {
        if (useNotices.getState().showNotices) useToast.getState().push(notice.title, notice.msg, 'info')
        return
      }
      const entry = entryFromEvent(ev)
      if (entry) {
        set((s) => ({
          log: [...s.log, entry],
          typing: entry.kind === 'character' ? null : s.typing,
          statusMsg: entry.kind === 'character' ? null : s.statusMsg,
        }))
      }
    }

    try {
      await streamChat(payload, handle, segments as PlayerSegment[] | undefined)
    } catch (e) {
      set((s) => ({
        streaming: false,
        log: [...s.log, { id: nextId(), kind: 'system', text: `对话失败：${(e as Error).message}` }],
      }))
    }
    // 兜底：流已结束但没收到 turn_end/error 时，确保输入框与发送按钮解锁。
    if (get().streaming) {
      set({ streaming: false, statusMsg: null, typing: null })
    }
  },

  rewindLast: async () => {
    if (get().streaming) return
    const storyMode = Boolean(get().appState?.story_mode)
    set({ streaming: true, statusMsg: storyMode ? '正在重写剧情…' : '正在重新生成这一回合…', typing: null })
    const handle = (ev: SSEEvent) => {
      if (ev.type === 'turn_end') {
        const state = ev.state as AppState
        set(() => ({ appState: state, log: buildLog(state), streaming: false, statusMsg: null, typing: null }))
        return
      }
      if (ev.type === 'rewind_state') {
        const state = ev.state as AppState
        set(() => ({ appState: state, log: buildLog(state) }))
        return
      }
      if (ev.type === 'processing') {
        set(() => ({ statusMsg: ev.text as string }))
        return
      }
      if (ev.type === 'character_delta') {
        set(() => ({
          typing: {
            character: ev.character as string,
            name: ev.name as string,
            text: ev.text as string,
          },
        }))
        return
      }
      if (ev.type === 'error') {
        set((s) => ({
          streaming: false,
          statusMsg: null,
          log: [...s.log, { id: nextId(), kind: 'system', text: `重写失败：${ev.text}` }],
        }))
        return
      }
      const entry = entryFromEvent(ev)
      if (entry) {
        set((s) => ({ log: [...s.log, entry], typing: entry.kind === 'character' ? null : s.typing }))
      }
    }
    try {
      await streamRewind(handle)
    } catch (e) {
      set((s) => ({
        streaming: false,
        statusMsg: null,
        log: [...s.log, { id: nextId(), kind: 'system', text: `重写失败：${(e as Error).message}` }],
      }))
    }
    if (get().streaming) {
      set({ streaming: false, statusMsg: null, typing: null })
    }
  },

  manualUpdate: async (target) => {
    if (get().streaming) return
    set({
      streaming: true,
      statusMsg: target === 'world' ? '正在更新世界…' : '正在更新角色状态与规划…',
      typing: null,
    })
    const handle = (ev: SSEEvent) => {
      if (ev.type === 'turn_end') {
        const state = ev.state as AppState
        set(() => ({ appState: state, streaming: false, statusMsg: null, typing: null }))
        maybeStartUpdatePoll(state)
        return
      }
      if (ev.type === 'error') {
        set((s) => ({
          streaming: false,
          statusMsg: null,
          log: [...s.log, { id: nextId(), kind: 'system', text: `更新失败：${ev.text}` }],
        }))
        return
      }
      if (ev.type === 'processing') {
        if (!useNotices.getState().showNotices && isQuietProcessing(ev.text as string)) return
        set(() => ({ statusMsg: ev.text as string }))
        return
      }
      const notice = noticeEntry(ev)
      if (notice) {
        if (useNotices.getState().showNotices) useToast.getState().push(notice.title, notice.msg, 'info')
        return
      }
      const entry = entryFromEvent(ev)
      if (entry) {
        set((s) => ({ log: [...s.log, entry], typing: entry.kind === 'character' ? null : s.typing }))
      }
    }
    try {
      await streamManualUpdate(target, handle)
    } catch (e) {
      set((s) => ({
        streaming: false,
        statusMsg: null,
        log: [...s.log, { id: nextId(), kind: 'system', text: `更新失败：${(e as Error).message}` }],
      }))
    }
    if (get().streaming) {
      set({ streaming: false, statusMsg: null, typing: null })
    }
  },

  toggleThink: async (value) => {
    const res = await setThink(value)
    set((s) => (s.appState ? { appState: { ...s.appState, show_thought: res.show_thought } } : s))
  },

  setStoryMode: async (enabled) => {
    const r = await setStoryMode(enabled)
    set((s) => (s.appState
      ? { appState: { ...s.appState, ...(r.state as AppState), story_mode: r.story_mode } }
      : s))
  },

  reset: async () => {
    set({ streaming: false })
    const state = await resetSession()
    set({ appState: state, log: [] })
  },
}))

function buildCombined(segments: PlayerSegment[], playerName: string): string {
  const labels: Record<PlayerSegment['type'], string> = { speech: '说道', action: '做了', think: '下令' }
  return segments
    .map((s) => {
      const text = s.text.trim()
      if (!text) return ''
      if (s.type === 'speech') return `${playerName}${labels.speech}：「${text}」`
      if (s.type === 'action') return `${playerName}${labels.action}：${text}`
      return `【世界指令】${text}`
    })
    .filter(Boolean)
    .join(' ')
}

// 保留一个非流式发送，便于低网络环境下的兜底（当前主要用流式）。
export async function fallbackSend(text: string) {
  return sendChat(text)
}
