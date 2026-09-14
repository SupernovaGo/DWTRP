import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useApp } from '@/store/appStore'
import { weatherEmoji, parseClock } from '@/lib/format'
import { Clock, MapPin, Pencil, FastForward } from 'lucide-react'
import EnvironmentEditDialog from '@/components/EnvironmentEditDialog'
import { advancePerceptionTime } from '@/lib/api'
import type { WorldLocation } from '@/types'
import { t } from '@/i18n'

interface LocNode {
  name: string
  description: string
}

/** 在世界书地点树里找到与当前地点匹配的最深节点链（根 → 该节点），每级带各自介绍。 */
function findLocationChain(locs: WorldLocation[], current: string): LocNode[] | null {
  let best: LocNode[] | null = null
  const walk = (nodes: WorldLocation[], path: LocNode[]) => {
    for (const node of nodes || []) {
      const name = (node.name || '').trim()
      if (!name) continue
      const nd = [...path, { name, description: (node.description || '').trim() }]
      if (name && (current.includes(name) || name.includes(current))) {
        if (!best || nd.length > best.length) best = nd
      }
      walk(node.children || [], nd)
    }
  }
  walk(locs || [], [])
  return best
}

/** 地点可逐级点击：哪一级在世界书里有介绍，点那一级就显示那一级的介绍气泡。 */
function LocationLabel({ text, locations }: { text: string; locations: WorldLocation[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const chain = findLocationChain(locations, text)
  const canBubble = Boolean(chain && chain.length && text)

  useEffect(() => {
    if (openIndex === null) return
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenIndex(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openIndex])

  const toggle = (index: number) => {
    const node = chain?.[index]
    if (!node || !node.description) return
    if (openIndex === index) {
      setOpenIndex(null)
      return
    }
    const rect = wrapRef.current?.getBoundingClientRect()
    if (rect) {
      setPos({
        top: rect.bottom + 6,
        left: Math.min(Math.max(8, rect.left), window.innerWidth - 304),
      })
    }
    setOpenIndex(index)
  }

  const segments = canBubble ? chain! : [{ name: text || t('未定义'), description: '' }]

  return (
    <div className="relative min-w-0" ref={wrapRef}>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {segments.map((node, i) => {
          const clickable = Boolean(node.description)
          return (
            <span key={`${node.name}-${i}`} className="flex min-w-0 items-center gap-x-1">
              {i > 0 && <span className="shrink-0 text-muted-foreground/60">›</span>}
              <button
                type="button"
                className={`min-w-0 break-words whitespace-normal text-left text-sm font-medium sm:text-base ${clickable ? 'cursor-pointer underline decoration-dotted underline-offset-2 hover:text-violet-600 dark:hover:text-violet-300' : 'cursor-default'}`}
                onClick={() => toggle(i)}
                title={clickable ? t('点击查看该地点介绍') : undefined}
              >
                {node.name}
              </button>
            </span>
          )
        })}
      </div>
      {openIndex !== null && canBubble && pos && chain?.[openIndex] && (
        <div
          className="fixed z-50 w-72 max-w-[calc(100vw-3rem)] rounded-lg border border-border/60 bg-popover p-3 text-sm leading-relaxed text-popover-foreground shadow-md"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="mb-1 flex items-start justify-between gap-2">
            <span className="font-semibold text-violet-700 dark:text-violet-200">{chain!.map((n) => n.name).join(' › ')}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setOpenIndex(null)}
              aria-label={t("关闭")}
            >
              ✕
            </button>
          </div>
          <p className="whitespace-pre-wrap text-[13px]">{chain![openIndex].description}</p>
        </div>
      )}
    </div>
  )
}

export default function EnvironmentPanel({ compact = false }: { compact?: boolean }) {
  const appState = useApp((s) => s.appState)
  const log = useApp((s) => s.log)
  const [editing, setEditing] = useState(false)

  const { lastEnv, prevEnv } = useMemo(() => {
    const envs = log.filter((e): e is Extract<(typeof log)[number], { kind: 'environment' }> => e.kind === 'environment')
    const last = envs[envs.length - 1] ?? null
    const prev = envs[envs.length - 2] ?? null
    return { lastEnv: last, prevEnv: prev }
  }, [log])

  if (!appState) return null
  const clock = parseClock(appState.clock)
  const env = lastEnv?.perception
  const changed = lastEnv?.changed ?? []
  const toDetail = (d: unknown): { id: string; text: string } =>
    typeof d === 'string' ? { id: d, text: d } : { id: String((d as { id?: string })?.id ?? ''), text: String((d as { text?: string })?.text ?? '') }
  const detailText = (d: unknown) => toDetail(d).text
  const details = (env?.details ?? appState.perception.details ?? []).map(toDetail)
  const prevDetails = (prevEnv?.perception?.details ?? []).map(detailText)
  const sceneChars = env?.scene_characters ?? appState.perception.scene_characters ?? []
  const newDetails = new Set(details.filter((d) => !prevDetails.includes(d.text)).map((d) => d.text))
  const changedFor = (key: string) =>
    changed.includes(key) && env?.[key as keyof typeof env] !== undefined

  if (compact) {
    // 手机端紧凑面板：去掉“环境面板”标题，按钮已移到顶部工具栏
    return (
      <div className="flex h-full flex-col gap-1 overflow-y-auto p-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Clock className="size-3.5 shrink-0 text-violet-700 dark:text-violet-300" />
          <span className="text-base font-bold tracking-tight">{clock.time}</span>
          <span className="text-[11px] text-muted-foreground">{clock.date}</span>
          <span className="ml-auto flex items-center gap-1">
            <span className="text-base">{weatherEmoji(appState.weather)}</span>
            <span className="text-xs font-medium">{appState.weather ? t(appState.weather) : t('未知天气')}</span>
            {changedFor('weather') && <Badge className="text-[9px]">NEW!</Badge>}
          </span>
        </div>
        <div className="flex items-start gap-1.5">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-fuchsia-600 dark:text-fuchsia-300" />
          <LocationLabel text={appState.location} locations={appState.locations ?? []} />
          {changedFor('location') && <Badge className="text-[9px]">NEW!</Badge>}
        </div>
        {sceneChars.length > 0 && (
          <div className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-border/70 bg-background/50 px-2 py-0.5 text-[12px] leading-snug">
            {sceneChars.map((c, i) => (
              <span key={`${c.name}-${i}`} className="inline-flex items-center gap-0.5">
                {c.isolated && <span className="text-[10px]">📞</span>}
                <span className="font-medium">{c.name}</span>
              </span>
            ))}
          </div>
        )}
        {details.length > 0 ? (
          <ul className="space-y-0.5">
            {details.map((d, i) => (
              <li key={`${d.id}-${i}`} className="flex items-start gap-1 text-[12px] leading-snug">
                <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${newDetails.has(d.text) ? 'bg-fuchsia-300' : 'bg-fuchsia-400'}`} />
                <span className="min-w-0">
                  {d.text}
                  {newDetails.has(d.text) && <Badge className="ml-1 text-[9px]">NEW!</Badge>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">{t('暂无额外信息')}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto p-2 sm:p-3">
      <Card className="shrink-0 overflow-hidden border-border/60 bg-gradient-to-br from-violet-500/10 via-transparent to-fuchsia-500/10">
        <CardHeader className="pb-1">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold text-violet-700 dark:text-violet-200">{t('🌐 环境面板')}</CardTitle>
            <Button size="icon-sm" variant="ghost" className="h-7 w-7 self-center" onClick={() => setEditing(true)} title={t("编辑环境")}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Clock className="size-4 shrink-0 text-violet-700 dark:text-violet-300" />
            <span className="text-lg font-bold tracking-tight sm:text-xl">{clock.time}</span>
            <span className="text-xs text-muted-foreground">{clock.date}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-lg sm:text-xl">{weatherEmoji(appState.weather)}</span>
              <span className="text-xs font-medium sm:text-sm">{appState.weather ? t(appState.weather) : t('未知天气')}</span>
              {changedFor('weather') && <Badge className="text-[10px]">NEW!</Badge>}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 size-4 shrink-0 text-fuchsia-600 dark:text-fuchsia-300" />
            <LocationLabel text={appState.location} locations={appState.locations ?? []} />
            {changedFor('location') && <Badge className="text-[10px]">NEW!</Badge>}
          </div>
          {appState.manual_time_advance && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-full justify-start gap-1.5 text-xs text-muted-foreground"
              onClick={async () => {
                const r = await advancePerceptionTime()
                useApp.getState().applyState(r.state)
              }}
            >
              <FastForward className="size-3.5" /> {t('手动推进时间')}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="flex min-h-[160px] flex-1 flex-col border-border/60 bg-background/40">
        <CardHeader className="shrink-0 pb-1">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="shrink-0 text-sm font-semibold text-muted-foreground">{t('环境信息')}</CardTitle>
            {sceneChars.length > 0 && (
              <div className="inline-flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 rounded-md border border-border/70 bg-background/50 px-2 py-0.5 text-[12px]">
                {sceneChars.map((c, i) => (
                  <span key={`${c.name}-${i}`} className="inline-flex items-center gap-1">
                    {c.isolated && <span className="text-[11px]">📞</span>}
                    <span className="font-medium">{c.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto pr-1">
          <ul className="space-y-2 text-[13px] sm:text-[15px]">
            {details.map((d, i) => (
              <li
                key={`${d.id}-${i}`}
                className="flex items-start gap-1.5 px-1.5 py-0.5"
              >
                <span className={`mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full ${newDetails.has(d.text) ? 'bg-fuchsia-300' : 'bg-fuchsia-400'}`} />
                <span className="min-w-0">
                  {d.text}
                  {newDetails.has(d.text) && <Badge className="ml-1.5 text-[10px]">NEW!</Badge>}
                </span>
              </li>
            ))}
            {details.length === 0 && (
              <li className="text-sm text-muted-foreground">{t('暂无额外信息')}</li>
            )}
          </ul>
          </div>
        </CardContent>
      </Card>
      <EnvironmentEditDialog open={editing} onClose={() => setEditing(false)} />
    </div>
  )
}
