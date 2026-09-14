import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  getLogs,
  getLogContent,
  type LogSession,
  type LogSessionFile,
} from '@/lib/api'
import { ChevronDown, ChevronRight, FileText, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

function groupFiles(files: LogSessionFile[]) {
  const map = new Map<string, LogSessionFile[]>()
  for (const f of files) {
    const key = f.date || t('未知日期')
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(f)
  }
  return [...map.entries()]
    .map(([date, fs]) => ({
      date,
      files: fs.sort(
        (a, b) => (a.kind === 'llm' ? -1 : 1) - (b.kind === 'llm' ? -1 : 1) || a.name.localeCompare(b.name),
      ),
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
}

export default function LogsView() {
  const [sessions, setSessions] = useState<LogSession[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<{ session: string; name: string } | null>(null)
  const [rows, setRows] = useState<Record<string, any>[]>([])
  const [q, setQ] = useState('')          // 左侧：按文件名筛选
  const [contentQ, setContentQ] = useState('')  // 右侧：按日志内容搜索
  const [filter, setFilter] = useState('')      // 右侧：按 agent / 事件 kind 筛选

  const reload = async () => {
    const r = await getLogs()
    setSessions(r.sessions)
    setExpanded((prev) => {
      if (prev.size) return prev
      return r.sessions[0] ? new Set([r.sessions[0].id]) : prev
    })
  }
  useEffect(() => { reload() }, [])

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const open = async (session: string, name: string) => {
    setSel({ session, name })
    setFilter('')
    setContentQ('')
    const r = await getLogContent(session, name)
    setRows(r.content)
  }

  const refresh = async () => {
    await reload()
    if (sel) open(sel.session, sel.name)
  }

  const filtered = sessions.map((s) => ({
    ...s,
    files: s.files.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase())),
  })).filter((s) => s.files.length > 0)

  // 从已加载内容里提取可筛选的 agent / 事件 kind
  const filterOptions = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>()
    for (const r of rows) {
      const key = String(r.agent || r.kind || 'unknown').toLowerCase()
      const label = r.agent || `${t('事件·')}${r.kind || 'unknown'}`
      const cur = map.get(key)
      map.set(key, { label, count: (cur?.count ?? 0) + 1 })
    }
    return [...map.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))
  }, [rows])

  const filteredRows = useMemo(() => {
    const needle = contentQ.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter) {
        const id = String(r.agent || r.kind || 'unknown').toLowerCase()
        if (id !== filter) return false
      }
      if (needle) {
        const hay = JSON.stringify(r).toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [rows, filter, contentQ])

  return (
    <div className="grid h-full grid-cols-1 gap-4 p-5 md:grid-cols-[320px_1fr]">
      <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
        <div className="flex items-center justify-between">
          <span className="text-base font-semibold text-violet-700 dark:text-violet-200">{t('会话日志')}</span>
          <Button size="sm" variant="outline" onClick={refresh}>{t('刷新')}</Button>
        </div>
        <Input className="mb-1" placeholder={t("按文件名筛选…")} value={q} onChange={(e) => setQ(e.target.value)} />
        {filtered.length === 0 && <p className="pt-2 text-sm text-muted-foreground">{t('暂无日志，跑一轮对话后生成。')}</p>}
        {filtered.map((s) => {
          const isOpen = expanded.has(s.id)
          return (
            <div key={s.id} className="overflow-hidden rounded-lg border border-border/60 bg-background/40">
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
                onClick={() => toggle(s.id)}
              >
                {isOpen ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{s.files.length}</span>
              </button>
              {isOpen && (
                <div className="space-y-1 border-t border-border/40 px-2 pb-2 pt-1">
                  {groupFiles(s.files).map((g) => (
                    <div key={g.date} className="space-y-0.5">
                      <div className="px-1 pt-1 text-xs font-semibold text-muted-foreground">{g.date}</div>
                      {g.files.map((f) => {
                        const active = sel?.session === s.id && sel?.name === f.name
                        return (
                          <button
                            key={f.name}
                            className={cn(
                              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors',
                              active ? 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-100' : 'hover:bg-muted/50',
                            )}
                            onClick={() => open(s.id, f.name)}
                          >
                            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">{f.kind === 'llm' ? `${t('LLM 调用 · ')}${f.name}` : `${t('运行事件 · ')}${f.name}`}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{Math.round(f.size / 1024)}KB</span>
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="min-h-0 space-y-3 overflow-y-auto">
        {rows.length === 0 && <p className="pt-6 text-center text-base text-muted-foreground">{t('选择一个会话日志文件查看内容。')}</p>}
        {rows.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-52">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-8" placeholder={t("在日志内容中搜索…")} value={contentQ} onChange={(e) => setContentQ(e.target.value)} />
              </div>
              <span className="text-xs text-muted-foreground">{t('共 {total} 行 / 命中 {hit} 行', { total: rows.length, hit: filteredRows.length })}</span>
            </div>
            {sel && !sel.name.includes('llm_') && (
              <p className="mb-2 text-xs text-muted-foreground">
                {t('运行事件（events_*.jsonl）：记录非 LLM 调用的关键运行事件——如')} <code>turn_done</code>{t('、')}<code>environment</code>{t('、')}
                <code>memory_summary</code>{t('、')}<code>unknown_character</code>{t('、')}<code>forget</code> {t('等。')}
                {t('用于排查“环境在变但角色不开口”“记忆未生效”等流程问题。')}
              </p>
            )}
            {filterOptions.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  className={cn('rounded-full px-3 py-1 text-xs', !filter ? 'bg-fuchsia-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80')}
                  onClick={() => setFilter('')}
                >
                  {t('全部')}
                </button>
                {filterOptions.map(([key, item]) => (
                  <button
                    key={key}
                    className={cn('rounded-full px-3 py-1 text-xs', filter === key ? 'bg-fuchsia-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80')}
                    onClick={() => setFilter(filter === key ? '' : key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="space-y-3">
          {filteredRows.map((r, i) => (
            <Card key={i} className="border-border/60 bg-background/40">
              <CardContent className="px-3 py-2">
                {r.agent ? (
                  <AgentLog row={r} />
                ) : (
                  <EventLog row={r} />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}

function CollapseSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-lg border border-border/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 bg-muted/30 px-2.5 py-1.5 text-left text-xs font-semibold text-muted-foreground hover:bg-muted/50"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        {title}
      </button>
      {open && <div className="border-t border-border/40 p-2">{children}</div>}
    </div>
  )
}

function AgentLog({ row }: { row: Record<string, any> }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        <Badge className="text-[11px]">{row.agent}</Badge>
        <span className="text-xs text-muted-foreground">{row.ts}</span>
        <span className="text-xs text-muted-foreground">#{row.request_id}</span>
        {row.empty && (
          <Badge variant="secondary" className="text-[11px]">
            {row.empty_kind === 'explicit' ? t('明确返回空') : t('返回为空')}
          </Badge>
        )}
        {row.unparseable && (
          <Badge variant="destructive" className="text-[11px]">{t('解析失败')}</Badge>
        )}
        {row.silent && (
          <Badge variant="secondary" className="text-[11px]">{t('解析为空')}</Badge>
        )}
      </button>
      {open && (
        <div className="space-y-2 pl-5">
          <CollapseSection title={t("提示词（send）")}>
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
              {renderMessages(row.messages)}
            </pre>
          </CollapseSection>
          <CollapseSection title={t("原始模型返回（raw）")}>
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
              {row.raw || t('(空)')}
            </pre>
          </CollapseSection>
          {row.thinking && (
            <CollapseSection title={t("模型思考（reasoning_content）")}>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
                {row.thinking}
              </pre>
            </CollapseSection>
          )}
          {row.params && (
            <CollapseSection title={t("调用参数")}>
              <div className="rounded-lg bg-muted/40 p-3 text-xs">
                {typeof row.params === 'object' ? (
                  <dl className="grid grid-cols-2 gap-1">
                    {Object.entries(row.params).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <dt className="text-muted-foreground">{t('{key}：', { key: k })}</dt>
                        <dd className="break-all">{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : String(row.params)}
              </div>
            </CollapseSection>
          )}
          <CollapseSection title={t("解析结果")} defaultOpen>
            <div className="rounded-lg bg-muted/40 p-3 text-xs">
              <ParsedView row={row} />
            </div>
          </CollapseSection>
          {row.error && <div className="text-xs text-red-600 dark:text-red-400">{t('错误：')}{row.error}</div>}
        </div>
      )}
    </div>
  )
}

function ParsedView({ row }: { row: Record<string, any> }) {
  const parsed = row.parsed
  if (!parsed) return <span className="text-muted-foreground">{t('（无）')}</span>
  // 用可读摘要代替一坨 JSON：角色回复展示思考/动作/说话；其余按 agent 简要渲染。
  const lines: string[] = []
  if (parsed.thought) lines.push(`${t('思考：')}${parsed.thought}`)
  for (const seg of parsed.sequence ?? []) {
    const txt = typeof seg === 'string' ? seg : (seg?.text ?? '')
    lines.push(`${seg?.type === 'action' ? t('*动作*') : t('说话')}${t('：')}${txt}`)
  }
  if (parsed.invoke) {
    for (const inv of parsed.invoke ?? []) {
      const c = typeof inv === 'string' ? inv : inv?.character
      lines.push(`${t('调用角色：')}${c || ''}`)
    }
  }
  if (parsed.updates) lines.push(`${t('角色更新条数：')}${(parsed.updates ?? []).length}`)
  if (parsed.changes) lines.push(`${t('世界变化条数：')}${(parsed.changes ?? []).length}`)
  if (parsed.environment) {
    const env = parsed.environment
    if (Array.isArray(env.updates)) lines.push(`${t('环境更新条数：')}${env.updates.length}`)
    else lines.push(`${t('环境：')}${JSON.stringify(env).slice(0, 200)}`)
  }
  if (parsed.events) lines.push(`${t('事件数：')}${(parsed.events ?? []).length}`)
  if (parsed.text) lines.push(`${t('建议文本：')}${parsed.text}`)
  if (!lines.length) lines.push(JSON.stringify(parsed, null, 2))
  return (
    <div className="space-y-1">
      {lines.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)}
    </div>
  )
}

function renderMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return t('(无)')
  return messages.map((m) => `${m.role}${t('：\n')}${m.content}`).join('\n\n----\n\n')
}

function eventSummary(kind: string, rest: Record<string, any>): string {
  const label: Record<string, string> = {
    turn_done: t('✅ 本回合已完成'),
    environment: t('🌐 环境更新'),
    character: t('💬 角色回应'),
    character_update: t('🔄 已更新角色'),
    world_update: t('🌍 世界更新'),
    memory_summary: t('💭 整理/总结记忆'),
    forget: t('🗑️ 记忆遗忘'),
    processing: t('⏳ 处理中'),
    hint: t('🔔 系统提示'),
  }
  let s = label[kind] || kind
  if (kind === 'turn_done' && Array.isArray(rest.events)) {
    s += `${t('；本回合产出事件类型：')}${rest.events.join(t(' · '))}`
  }
  if (kind === 'character_update' && Array.isArray(rest.updated)) {
    s += `${t('：')}${rest.updated.join(t('、'))}`
  }
  if (kind === 'character' && rest.name) s += `${t('：')}${rest.name}`
  if (kind === 'environment' && Array.isArray(rest.changed)) {
    s += `${t('；变化字段：')}${rest.changed.join(t('、'))}`
  }
  return s || kind
}

function EventLog({ row }: { row: Record<string, any> }) {
  const { ts, request_id, kind, ...rest } = row
  const [open, setOpen] = useState(true)
  return (
    <div className="space-y-1.5 text-sm">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        <Badge variant="outline" className="text-[11px]">{kind}</Badge>
        <span className="text-xs text-muted-foreground">{ts}</span>
        <span className="text-xs text-muted-foreground">#{request_id || ''}</span>
      </button>
      {open && (
        <div className="space-y-1 pl-5">
          <p className="text-xs text-muted-foreground">{eventSummary(kind, rest)}</p>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs">
            {JSON.stringify(rest, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
