import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getMemory, deleteMemoryEvent, addMemoryEvent } from '@/lib/api'
import type { MemoryData } from '@/types'
import { t } from '@/i18n'

function StorageBar({ used, max }: { used: number; max: number }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((used / max) * 100))
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="mb-1 flex items-end justify-between">
        <span className="text-sm text-muted-foreground">{t('长期记忆容量')}</span>
        <span className="text-base font-semibold">
          {used}
          <span className="text-sm font-normal text-muted-foreground">{t(' / {n} 事件', { n: max })}</span>
        </span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-right text-[11px] text-muted-foreground">{t('{n}% 已用', { n: pct })}</div>
    </div>
  )
}

function ImportanceChart({ data }: { data: { name: string; value: number }[] }) {
  if (data.length === 0) {
    return <p className="py-6 text-center text-xs text-muted-foreground">{t('暂无记忆，聊一聊就会开始积累。')}</p>
  }
  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 8, bottom: 0, left: 0, right: 8 }}>
        <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
        <YAxis domain={[0, 1]} width={36} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
        <Tooltip
          cursor={{ fill: 'rgba(139,92,246,0.08)' }}
          contentStyle={{
            background: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.value >= 0.7 ? '#a855f7' : d.value >= 0.4 ? '#8b5cf6' : '#6366f1'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export default function MemoryDetail({ cid }: { cid: string }) {
  const [data, setData] = useState<MemoryData | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [summary, setSummary] = useState('')
  const [importance, setImportance] = useState(0.6)

  useEffect(() => {
    if (!cid) return
    getMemory(cid).then(setData).catch(() => setData(null))
  }, [cid])

  const chart = useMemo(() => {
    const events = data?.events ?? []
    return events
      .slice()
      .sort((a, b) => a.time_seq - b.time_seq)
      .map((e) => ({ name: `#${e.time_seq}`, value: e.importance }))
  }, [data])

  const reload = () => cid && getMemory(cid).then(setData)

  const onDelete = async (eid: string) => {
    if (!cid) return
    await deleteMemoryEvent(cid, eid)
    reload()
  }

  const onAdd = async () => {
    if (!cid || !summary.trim()) return
    await addMemoryEvent(cid, { summary, importance })
    setSummary('')
    setShowAdd(false)
    reload()
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex shrink-0 items-center justify-between">
        <div className="text-sm text-muted-foreground">{t('💭 角色的长期记忆')}</div>
        <Button size="sm" variant="outline" onClick={() => setShowAdd((v) => !v)}>{t('+ 添加')}</Button>
      </div>

      {showAdd && (
        <Card className="shrink-0 border-primary/30 bg-primary/5">
          <CardContent className="space-y-2 px-3 py-3">
            <Input placeholder={t("记忆摘要（必填）")} value={summary} onChange={(e) => setSummary(e.target.value)} />
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t('重要度 {v}', { v: importance.toFixed(2) })}</span>
              <input type="range" min={0} max={1} step={0.05} value={importance}
                onChange={(e) => setImportance(Number(e.target.value))} className="flex-1 accent-fuchsia-500" />
              <Button size="sm" onClick={onAdd}>{t('保存记忆')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="shrink-0"><StorageBar used={data?.stats.events ?? 0} max={data?.max_events ?? 300} /></div>

      <Card className="shrink-0 border-border/60 bg-background/40">
        <CardHeader className="pb-1">
          <CardTitle className="text-sm font-semibold text-muted-foreground">{t('记忆结构 · 事件重要度走势')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-2 flex gap-2 text-sm">
            <Badge variant="secondary">{t('事件 {n}', { n: data?.stats.events ?? 0 })}</Badge>
          </div>
          <ImportanceChart data={chart} />
        </CardContent>
      </Card>

      <Card className="flex min-h-[220px] flex-1 flex-col border-border/60 bg-background/40">
        <CardHeader className="shrink-0 pb-1">
          <CardTitle className="text-sm font-semibold text-muted-foreground">{t('事件列表 · 近期记忆 {n} 条', { n: data?.stats.working_turns ?? 0 })}</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1">
          <ScrollArea className="h-full pr-2">
            <div className="space-y-2">
              {(data?.events ?? []).map((ev) => (
                <div key={ev.event_id} className="group rounded-lg border border-border/60 bg-background/30 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">{t('#{seq} · 重要度 {v}', { seq: ev.time_seq, v: (ev.importance ?? 0).toFixed(2) })}</div>
                    <Button size="sm" variant="ghost" className="h-5 px-2 text-[11px] text-red-600 dark:text-red-400 opacity-0 group-hover:opacity-100"
                      onClick={() => onDelete(ev.event_id)}>{t('删除')}</Button>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed">{ev.summary}</p>
                </div>
              ))}
              {(data?.events ?? []).length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t('暂无长期记忆。')}</p>}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
