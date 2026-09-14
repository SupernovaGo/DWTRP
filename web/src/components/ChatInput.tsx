import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { XIcon, SlidersHorizontal, Send, Feather, AlertTriangle } from 'lucide-react'
import { useApp } from '@/store/appStore'
import WorldDirectiveDialog from '@/components/WorldDirectiveDialog'
import SavepointDialog from '@/components/SavepointDialog'
import type { PlayerSegment } from '@/types'
import { SEG_LABELS } from '@/store/renderPrefs'
import { cn } from '@/lib/utils'
import { assist } from '@/lib/api'
import { useToast } from '@/store/toastStore'
import { useShortcuts } from '@/store/shortcuts'
import { useComposer } from '@/store/composer'
import { useShell } from '@/store/useShell'
import { isApiKeyMissing, useMissingApiKey } from '@/store/apiKeyStore'
import { fnById, type FnId } from '@/lib/functions'
import { t } from '@/i18n'

// 「添加一条」只在说/做之间循环；指令（think）需从下拉框手动选择。
const CYCLE_TYPES = ['speech', 'action'] as const
const SEG_TYPES = ['speech', 'action', 'think'] as const

const TYPE_LETTERS: Record<PlayerSegment['type'], string> = {
  speech: 'S',
  action: 'A',
  think: 'T',
}

const TYPE_BASE: Record<PlayerSegment['type'], string> = {
  speech: 'bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-400/40',
  action: 'bg-orange-500/15 text-orange-700 dark:text-orange-200 border-orange-400/40',
  think: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-200 border-fuchsia-400/40',
}

function nextType(t: PlayerSegment['type']): PlayerSegment['type'] {
  const idx = CYCLE_TYPES.indexOf(t as (typeof CYCLE_TYPES)[number])
  if (idx === -1) return 'speech'
  return CYCLE_TYPES[(idx + 1) % CYCLE_TYPES.length]
}

// 三种类型都允许输入；think 由后端转为一次性【世界指令】。
const sanitizeType = (t: PlayerSegment['type']): PlayerSegment['type'] => t

export default function ChatInput() {
  const [text, setText] = useState('')
  const precise = useComposer((s) => s.precise)
  const setPrecise = useComposer((s) => s.setPrecise)
  const [bubbles, setBubbles] = useState<PlayerSegment[]>([])
  const [current, setCurrent] = useState<PlayerSegment>({ type: 'speech', text: '' })
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [dirOpen, setDirOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const toolsRef = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const missingKey = useMissingApiKey()
  const streaming = useApp((s) => s.streaming)
  const send = useApp((s) => s.send)
  const app = useApp()
  const showThought = app.appState?.show_thought ?? false
  const storyMode = app.appState?.story_mode ?? false
  const storyAllowed = (id: string) => !storyMode || id === 'ai_rewrite' || id === 'savepoint'
  const shortcuts = useShortcuts((s) => s.shortcuts)
  const composerSeq = useComposer((s) => s.seq)
  const assistBusy = useComposer((s) => s.assistBusy)
  const setAssistBusy = useComposer((s) => s.setAssistBusy)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // 默认精确模式（可在 设置 → 个性化 里切换）
  useEffect(() => {
    setPrecise(useComposer.getState().defaultPrecise)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentFilled = current.text.trim().length > 0
  const finalSegments = (): PlayerSegment[] => {
    const fb = [...bubbles]
    if (editingIndex != null && currentFilled) fb[editingIndex] = { ...current, type: sanitizeType(current.type) }
    else if (editingIndex == null && currentFilled) fb.push({ ...current, type: sanitizeType(current.type) })
    return fb
      .filter((b) => b.text.trim())
      .map((b) => ({ ...b, type: sanitizeType(b.type) }))
  }
  const filled = precise ? finalSegments().length : (text.trim().length > 0 ? 1 : 0)
  const canSend = storyMode ? true : filled > 0
  const primaryEmpty = (storyMode || !precise) ? text.trim() === '' : current.text.trim() === ''
  const showStoryToggle = !streaming && !assistBusy && primaryEmpty

  const applySuggestion = (s: { text: string; segments?: PlayerSegment[] }) => {
    // AI 帮写：只采用精确（多段）模式，让用户自己决定类型后发送
    setPrecise(true)
    const segs = s.segments && s.segments.length
      ? s.segments
      : (s.text ? [{ type: 'speech' as const, text: s.text }] : [])
    if (segs.length) {
      setBubbles(segs)
      setCurrent({ type: 'speech', text: '' })
      setEditingIndex(null)
    }
  }

  useEffect(() => {
    if (composerSeq === 0) return
    const s = useComposer.getState().suggestion
    if (!s) return
    applySuggestion(s)
    useComposer.getState().clear()
  }, [composerSeq])

  const callAssist = async (mode: 'write' | 'rewrite') => {
    setToolsOpen(false)
    setAssistBusy(true)
    try {
      const r = await assist(mode)
      if (r.error) {
        toast.push(t('AI 生成失败'), r.error, 'error')
        return
      }
      if (!r.text && !((r.segments || []).length)) {
        toast.push(t('AI 没有给出建议'), t('可换个时间或再试一次'), 'error')
        return
      }
      applySuggestion({
        text: r.text ?? '',
        segments: (r.segments as PlayerSegment[] | undefined) ?? undefined,
      })
      toast.push(t('AI 已替你写了一句'), t('发送前可再修改'), 'success')
    } catch (e) {
      toast.push(t('AI 生成失败'), String(e), 'error')
    } finally {
      setAssistBusy(false)
    }
  }

  const callRewind = async () => {
    setToolsOpen(false)
    setAssistBusy(true)
    try {
      await useApp.getState().rewindLast()
    } catch (e) {
      toast.push(t('重写失败'), String(e), 'error')
    } finally {
      setAssistBusy(false)
    }
  }

  const invokeAction = (id: FnId) => {
    if (!storyAllowed(id)) return
    switch (id) {
      case 'world_directive':
        setDirOpen(true); setToolsOpen(false); break
      case 'savepoint':
        setSaveOpen(true); setToolsOpen(false); break
      case 'ai_write':
        callAssist('write'); break
      case 'ai_rewrite':
        callRewind(); break
      default:
        break
    }
  }

  const submit = () => {
    if (!canSend || streaming || assistBusy) return
    // 未配置 API Key：显式提醒并跳到设置，避免“发了没反应”。
    if (isApiKeyMissing()) {
      toast.push(t('未配置 API Key'), t('请先在「设置 → 连接 / 高级」里填写 DeepSeek API Key 后再发送'), 'error')
      useShell.getState().openSettings('connection')
      return
    }
    if (storyMode) {
      send(text)
      setText('')
      return
    }
    if (precise) {
      const segs = finalSegments()
      if (segs.length === 0) return
      send('', segs)
      setBubbles([])
      setCurrent({ type: 'speech', text: '' })
      setEditingIndex(null)
    } else {
      send(text)
      setText('')
    }
  }

  const patchCurrent = (patch: Partial<PlayerSegment>) =>
    setCurrent((c) => ({
      ...c,
      ...patch,
      type: sanitizeType(patch.type ?? c.type),
    }))

  const addSeg = () => {
    if (currentFilled) {
      if (editingIndex != null) {
        setBubbles((b) => b.map((seg, i) => (i === editingIndex ? { ...current } : seg)))
      } else {
        setBubbles((b) => [...b, { ...current }])
      }
    }
    setEditingIndex(null)
    setCurrent((c) => ({ type: nextType(c.type), text: '' }))
  }

  const removeBubble = (index: number) => {
    setBubbles((b) => b.filter((_, i) => i !== index))
    if (editingIndex === index) {
      setEditingIndex(null)
      setCurrent({ type: 'speech', text: '' })
    }
  }

  // 点击气泡 → 把它拉回编辑框，但不从列表移除，修改后“添加”会原位更新。
  const liftToEdit = (index: number) => {
    if (editingIndex === index) {
      // 正在编辑同一个气泡时再次点击，保留当前修改，不重置。
      setCurrent((c) => ({ ...c }))
      return
    }
    // 先提交正在编辑但尚未点“添加”的气泡，否则切换到另一个气泡时这处修改会被丢掉。
    if (editingIndex != null) {
      setBubbles((b) => b.map((seg, i) => (i === editingIndex ? { ...current } : seg)))
    }
    const seg = bubbles[index]
    if (!seg) return
    setCurrent({ ...seg, type: sanitizeType(seg.type) })
    setEditingIndex(index)
  }

  return (
    <motion.div
      className="border-t border-border/60 bg-card/60 px-3 py-2 backdrop-blur sm:px-4 sm:py-2.5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="flex w-full flex-col gap-1.5">
        {assistBusy && (
          <div className="text-center text-xs font-medium text-violet-600 dark:text-violet-300">{t('✨ AI 正在帮你写…')}</div>
        )}
        {missingKey && (
          <button
            type="button"
            onClick={() => useShell.getState().openSettings('connection')}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            {t('未配置 DeepSeek API Key，无法发送 — 点此去设置')}
          </button>
        )}
        <div className="flex min-w-0 flex-nowrap items-end gap-1.5 sm:gap-2">
          <div ref={toolsRef} className="relative shrink-0">
            <Button
              size="icon-lg"
              variant="ghost"
              className={cn('size-9 rounded-full border sm:size-10', toolsOpen ? 'border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-100' : 'border-border/60 text-muted-foreground')}
              onClick={() => setToolsOpen((v) => !v)}
              disabled={assistBusy}
              title={t("快捷功能")}
            >
              <SlidersHorizontal className="size-5" />
            </Button>
            {toolsOpen && (
              <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-border/60 bg-popover p-3 shadow-xl">
                <div className="space-y-1">
                  {shortcuts.map((id) => {
                    const fn = fnById(id)
                    if (!fn) return null
                    if (fn.kind === 'toggle') {
                      const checked = id === 'precise' ? precise : showThought
                      const onChange = (v: boolean) =>
                        id === 'precise' ? setPrecise(v) : app.toggleThink(v)
                      return (
                        <label key={id} className="flex items-center justify-between rounded-lg px-1.5 py-1.5 text-sm hover:bg-muted/40">
                          <span className="flex items-center gap-2">
                            <fn.icon className="size-4 text-muted-foreground" />
                            {t(fn.label)}
                          </span>
                          <Switch checked={checked} onCheckedChange={onChange} disabled={!storyAllowed(id)} />
                        </label>
                      )
                    }
                    return (
                      <Button
                        key={id}
                        className="w-full justify-start gap-2"
                        variant="ghost"
                        onClick={() => invokeAction(id)}
                        disabled={streaming || assistBusy || !storyAllowed(id)}
                      >
                        <fn.icon className="size-4 text-muted-foreground" />
                        {t(fn.label)}
                      </Button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1">
          {storyMode ? (
            <div className="relative flex min-w-0 flex-1">
              <Textarea
                className="min-h-[44px] max-h-36 flex-1 resize-none rounded-2xl bg-background/60 px-3 py-2 text-[15px] leading-relaxed sm:px-4 sm:py-2.5 sm:text-base"
                placeholder={t("输入剧情指令…（留空则自然推进剧情）")}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                disabled={streaming || assistBusy}
              />
              {showStoryToggle && (
                <button
                  type="button"
                  onClick={() => app.setStoryMode(false)}
                  className="absolute bottom-1.5 right-1.5 z-10 flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground transition-colors hover:text-violet-600 dark:hover:text-violet-300"
                  title={t("切回交互模式")}
                >
                  <Feather className="size-4" />
                </button>
              )}
            </div>
          ) : !precise ? (
            <div className="relative flex min-w-0 flex-1">
              <Textarea
                className="min-h-[44px] max-h-36 flex-1 resize-none rounded-2xl bg-background/60 px-3 py-2 text-[15px] leading-relaxed sm:px-4 sm:py-2.5 sm:text-base"
                placeholder={t("你想做什么…")}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                disabled={streaming || assistBusy}
              />
              {showStoryToggle && (
                <button
                  type="button"
                  onClick={() => app.setStoryMode(true)}
                  className="absolute bottom-1.5 right-1.5 z-10 flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground transition-colors hover:text-violet-600 dark:hover:text-violet-300"
                  title={t("切到故事模式")}
                >
                  <Feather className="size-4" />
                </button>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {bubbles.length > 0 && (
                <div className="flex max-h-9 flex-nowrap items-center gap-1.5 overflow-x-auto overflow-y-hidden pb-0.5">
                  {bubbles.map((seg, i) => (
                      <div
                        key={i}
                        className={cn(
                          'group flex min-w-0 shrink items-center gap-1 rounded-full border py-0.5 pl-1 pr-1 text-xs',
                          TYPE_BASE[seg.type],
                          i === editingIndex && 'ring-2 ring-fuchsia-400/70',
                        )}
                      >
                      <button
                        type="button"
                        onClick={() => liftToEdit(i)}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        title={t("点击展开编辑")}
                      >
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold">
                          {TYPE_LETTERS[seg.type]}
                        </span>
                        <span className="min-w-0 truncate">{seg.text}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeBubble(i)}
                        className="shrink-0 text-current/60 hover:text-current"
                        title={t("删除")}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex min-w-0 flex-nowrap items-end gap-1.5">
                <Select value={current.type} onValueChange={(v) => v && patchCurrent({ type: v as PlayerSegment['type'] })}>
                  <SelectTrigger className="h-10 w-11 shrink-0 justify-center px-0 sm:h-11 sm:w-[4.5rem] sm:justify-start sm:px-2">
                    <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold', TYPE_BASE[current.type])}>
                      {TYPE_LETTERS[current.type]}
                    </span>
                  </SelectTrigger>
                  <SelectContent align="start">
                    {SEG_TYPES.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        <span className="flex items-center gap-2">
                          <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold', TYPE_BASE[kind])}>
                            {TYPE_LETTERS[kind]}
                          </span>
                          {t(SEG_LABELS[kind])}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative min-w-0 flex-1">
                  <Textarea
                    className="min-h-10 max-h-28 flex-1 resize-none rounded-xl bg-background/60 px-3 py-2 text-[15px] leading-relaxed sm:min-h-11 sm:max-h-32 sm:text-base"
                    rows={1}
                    placeholder={t("填入内容…")}
                    value={current.text}
                    onChange={(e) => patchCurrent({ text: e.target.value })}
                    disabled={streaming || assistBusy}
                  />
                  {showStoryToggle && (
                    <button
                      type="button"
                      onClick={() => app.setStoryMode(!storyMode)}
                      className="absolute bottom-1.5 right-1.5 z-10 flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground transition-colors hover:text-violet-600 dark:hover:text-violet-300"
                      title={storyMode ? t('切回交互模式') : t('切到故事模式')}
                    >
                      <Feather className="size-4" />
                    </button>
                  )}
                </div>
                <Button size="sm" variant="outline" className="h-10 shrink-0 px-2 sm:h-11 sm:px-3" onClick={addSeg} disabled={streaming || assistBusy}>
                  {t('＋')}<span className="hidden sm:inline"> {t('添加')}</span>
                </Button>
              </div>
            </div>
          )}
          </div>

          <Button
            onClick={submit}
            disabled={streaming || assistBusy || !canSend}
            title={t("发送")}
            className="h-10 w-10 shrink-0 rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 sm:h-11 sm:w-11"
          >
            {streaming || assistBusy ? t('……') : <Send className="size-4 sm:size-5" />}
          </Button>
        </div>
      </div>

      <WorldDirectiveDialog open={dirOpen} onClose={() => setDirOpen(false)} />
      <SavepointDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </motion.div>
  )
}
