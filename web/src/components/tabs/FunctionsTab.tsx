import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FUNCTIONS } from '@/lib/functions'
import { useShortcuts } from '@/store/shortcuts'
import { useComposer } from '@/store/composer'
import { useApp } from '@/store/appStore'
import { useToast } from '@/store/toastStore'
import { assist } from '@/lib/api'
import WorldDirectiveDialog from '@/components/WorldDirectiveDialog'
import SavepointDialog from '@/components/SavepointDialog'
import type { FnId } from '@/lib/functions'
import type { PlayerSegment } from '@/types'

export default function FunctionsTab() {
  const toast = useToast()
  const shortcuts = useShortcuts((s) => s.shortcuts)
  const toggleShortcut = useShortcuts((s) => s.toggle)
  const precise = useComposer((s) => s.precise)
  const setPrecise = useComposer((s) => s.setPrecise)
  const app = useApp()
  const storyMode = app.appState?.story_mode ?? false
  const storyAllowed = (id: FnId) => !storyMode || id === 'ai_rewrite' || id === 'savepoint'
  const [dirOpen, setDirOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const runAssist = async (mode: 'write') => {
    setBusy(true)
    useComposer.getState().setAssistBusy(true)
    try {
      const r = await assist(mode)
      if (r.error) {
        toast.push('AI 生成失败', r.error, 'error')
        return
      }
      useComposer.getState().push({
        text: r.text ?? '',
        segments: (r.segments as PlayerSegment[] | undefined) ?? undefined,
      })
      toast.push('AI 已替你写了一句', '发送前可修改', 'success')
    } catch (e) {
      toast.push('AI 生成失败', String(e), 'error')
    } finally {
      setBusy(false)
      useComposer.getState().setAssistBusy(false)
    }
  }

  const callRewind = async () => {
    setBusy(true)
    useComposer.getState().setAssistBusy(true)
    try {
      await useApp.getState().rewindLast()
    } finally {
      setBusy(false)
      useComposer.getState().setAssistBusy(false)
    }
  }

  const invoke = (id: FnId) => {
    if (!storyAllowed(id)) {
      toast.push('故事模式下不可用', '仅保留「AI 重写」与「存档点」', 'error')
      return
    }
    switch (id) {
      case 'world_directive': setDirOpen(true); break
      case 'savepoint': setSaveOpen(true); break
      case 'ai_write': runAssist('write'); break
      case 'ai_rewrite': callRewind(); break
      case 'precise': setPrecise(!precise); break
      case 'show_thought': app.toggleThink(!app.appState?.show_thought); break
      default: break
    }
  }

  const isShortcut = (id: FnId) => shortcuts.includes(id)
  const toggleState = (id: FnId) => id === 'precise' ? precise : Boolean(app.appState?.show_thought)

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <div className="mb-2 shrink-0">
        <h3 className="text-base font-semibold text-violet-700 dark:text-violet-200">🧰 功能</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          点击卡片即可使用；打开「快捷键」后，它会出现在发送框左侧的工具里。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {FUNCTIONS.map((fn) => (
          <div key={fn.id} className="rounded-xl border border-border/60 bg-background/40 p-3">
            <button
              type="button"
              disabled={(busy && (fn.id === 'ai_write' || fn.id === 'ai_rewrite')) || !storyAllowed(fn.id)}
              className="flex w-full items-start gap-2 text-left disabled:opacity-50"
              onClick={() => invoke(fn.id)}
            >
              <fn.icon className="mt-0.5 size-5 shrink-0 text-violet-600 dark:text-violet-300" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold">{fn.label}</span>
                  <Tooltip>
                    <TooltipTrigger render={<Info className="size-3.5 shrink-0 cursor-help text-muted-foreground" />} />
                    <TooltipContent side="top">{fn.desc}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </button>
            <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-2">
              <span className="text-xs text-muted-foreground">
                {fn.kind === 'toggle' ? (toggleState(fn.id) ? '已开启' : '已关闭') : '点击使用'}
              </span>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                快捷键
                <Switch size="sm" checked={isShortcut(fn.id)} onCheckedChange={() => toggleShortcut(fn.id)} />
              </label>
            </div>
          </div>
        ))}
      </div>
      <WorldDirectiveDialog open={dirOpen} onClose={() => setDirOpen(false)} />
      <SavepointDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </div>
  )
}
