import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import EnvironmentPanel from '@/components/EnvironmentPanel'
import EnvironmentEditDialog from '@/components/EnvironmentEditDialog'
import StoryPanel from '@/components/StoryPanel'
import WorldPanel from '@/components/WorldPanel'
import ChatInput from '@/components/ChatInput'
import { useApp } from '@/store/appStore'
import { advancePerceptionTime } from '@/lib/api'
import { FastForward, Pencil } from 'lucide-react'
import { t } from '@/i18n'

const MIN_L = 320
const MIN_R = 340
const LEFT_KEY = 'panel-left'
const RIGHT_KEY = 'panel-right'
const MOBILE_ENV_KEY = 'mobile-env-pct'

const MOBILE_BP = '(max-width: 767px)'
const ENV_PCT_MIN = 0.2
const ENV_PCT_MAX = 0.75

function readPanel(key: string, def: number, min: number) {
  const v = Number(localStorage.getItem(key))
  return Number.isFinite(v) && v >= min ? v : def
}

function readPct() {
  const v = Number(localStorage.getItem(MOBILE_ENV_KEY))
  return Number.isFinite(v) && v >= ENV_PCT_MIN && v <= ENV_PCT_MAX ? v : 0.42
}

/** 是否处于移动端视口（跟随窗口尺寸变化）。 */
function useIsMobile() {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(MOBILE_BP).matches : false)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_BP)
    const onChange = () => setMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}

export default function MainView() {
  const appState = useApp((s) => s.appState)
  const [left, setLeft] = useState(() => readPanel(LEFT_KEY, 400, MIN_L))
  const [right, setRight] = useState(() => readPanel(RIGHT_KEY, 480, MIN_R))
  const containerRef = useRef<HTMLDivElement>(null)

  const isMobile = useIsMobile()
  const [envPct, setEnvPct] = useState(readPct)
  const [worldOpen, setWorldOpen] = useState(false)
  const [envCollapsed, setEnvCollapsed] = useState(false)
  const [editingEnv, setEditingEnv] = useState(false)

  useEffect(() => { localStorage.setItem(LEFT_KEY, String(left)) }, [left])
  useEffect(() => { localStorage.setItem(RIGHT_KEY, String(right)) }, [right])
  useEffect(() => { localStorage.setItem(MOBILE_ENV_KEY, String(envPct)) }, [envPct])

  const advanceTime = async () => {
    try {
      const r = await advancePerceptionTime()
      useApp.getState().applyState(r.state)
    } catch {
      /* ignore */
    }
  }

  // 世界面板抽屉打开时锁滚动背景
  useEffect(() => {
    document.body.style.overflow = worldOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [worldOpen])

  const startDrag = (
    axis: 'left' | 'right',
    e: React.PointerEvent,
  ) => {
    e.preventDefault()
    const startX = e.clientX
    const startL = left
    const startR = right
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (axis === 'left') {
        setLeft(Math.max(MIN_L, Math.min(startL + dx, 620)))
      } else {
        setRight(Math.max(MIN_R, Math.min(startR - dx, 700)))
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startVDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    const startY = e.clientY
    const startPct = envPct
    const onMove = (ev: PointerEvent) => {
      if (!rect) return
      const pct = Math.max(
        ENV_PCT_MIN,
        Math.min(ENV_PCT_MAX, startPct + (ev.clientY - startY) / rect.height),
      )
      setEnvPct(pct)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const worldPanel = useMemo(
    () => <WorldPanel onClose={() => setWorldOpen(false)} />,
    [],
  )

  if (!appState) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="text-5xl">✨</div>
        <p className="mt-3 text-sm text-muted-foreground">{t('加载会话中…')}</p>
      </div>
    )
  }

  if (isMobile) {
    return (
      <div ref={containerRef} className="relative flex h-full flex-col">
        {/* 移动端顶部：环境/聊天标题 + 世界面板开关 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-card/60 px-3 py-1.5">
          <button
            className="flex items-center gap-1 text-sm font-semibold text-violet-700 dark:text-violet-200"
            onClick={() => setEnvCollapsed((v) => !v)}
          >
            <span>{envCollapsed ? '▲' : '▼'}</span>
            <span>{t('🌐 环境')}</span>
          </button>
          <div className="flex items-center gap-2">
            <Button size="icon-sm" variant="ghost" className="h-8 w-8" onClick={advanceTime} title={t("手动推进时间")}>
              <FastForward className="size-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" className="h-8 w-8" onClick={() => setEditingEnv(true)} title={t("编辑环境")}>
              <Pencil className="size-4" />
            </Button>
            <span className="text-[11px] text-muted-foreground">{envCollapsed ? t('已收起') : `${Math.round(envPct * 100)}%`}</span>
            <Button size="sm" variant="outline" onClick={() => setWorldOpen(true)}>{t('🎛️ 世界')}</Button>
          </div>
        </div>

        {!envCollapsed && (
          <>
            <section style={{ height: `${envPct * 100}%` }} className="min-h-0 shrink-0 overflow-hidden">
              <EnvironmentPanel compact />
            </section>
            <div
              className="group flex h-1.5 shrink-0 cursor-row-resize touch-none items-center justify-center bg-border/30 transition-colors hover:bg-fuchsia-400/40"
              onPointerDown={startVDrag}
              title={t("拖动调整上下比例")}
            >
              <div className="h-0.5 w-10 rounded-full bg-fuchsia-400/40 transition-colors group-hover:bg-fuchsia-300/70" />
            </div>
          </>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <StoryPanel />
          </div>
          <ChatInput />
        </div>

        {/* 世界面板：移动端底部抽屉 */}
        {worldOpen && (
          <div
            className="fixed inset-0 z-50 flex flex-col justify-end bg-black/45 md:hidden"
            onClick={() => setWorldOpen(false)}
          >
            <div
              className="flex h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-border/60 bg-background shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="shrink-0 px-4 pt-2">
                <div className="mx-auto h-1 w-10 rounded-full bg-border" />
              </div>
              <div className="min-h-0 flex-1">{worldPanel}</div>
            </div>
          </div>
        )}
        <EnvironmentEditDialog open={editingEnv} onClose={() => setEditingEnv(false)} />
      </div>
    )
  }

  // 桌面端（保持原有横向三栏）
  return (
    <div ref={containerRef} className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside style={{ width: left }} className="shrink-0 overflow-hidden">
          <EnvironmentPanel />
        </aside>
        <div
          className="group flex w-1.5 shrink-0 cursor-col-resize touch-none items-center bg-border/30 transition-colors hover:bg-fuchsia-400/40"
          onPointerDown={(e) => startDrag('left', e)}
          title={t("拖动调整")}
        >
          <div className="mx-auto h-10 w-0.5 rounded-full bg-fuchsia-400/40 transition-colors group-hover:bg-fuchsia-300/70" />
        </div>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <StoryPanel />
          </div>
          <ChatInput />
        </main>
        <div
          className="group flex w-1.5 shrink-0 cursor-col-resize touch-none items-center bg-border/30 transition-colors hover:bg-fuchsia-400/40"
          onPointerDown={(e) => startDrag('right', e)}
          title={t("拖动调整")}
        >
          <div className="mx-auto h-10 w-0.5 rounded-full bg-fuchsia-400/40 transition-colors group-hover:bg-fuchsia-300/70" />
        </div>
        <aside style={{ width: right }} className="shrink-0 overflow-hidden">
          <WorldPanel />
        </aside>
      </div>
    </div>
  )
}
