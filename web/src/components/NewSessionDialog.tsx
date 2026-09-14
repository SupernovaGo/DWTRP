import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { WorldLocation } from '@/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  getLibraryWorldbooks,
  getLibraryCharacters,
  getLibraryCharacterTags,
  getSessionWorldbooks,
  getSessionWorldbook,
  listIdentities,
  createSession,
  initSession,
  startSession,
  type LibraryWorldbook,
  type LibraryCharacter,
  type IdentityItem,
  importSnapshot,
} from '@/lib/api'
import { useApp } from '@/store/appStore'
import { useToast } from '@/store/toastStore'
import { useShell } from '@/store/useShell'
import { weatherEmoji, WEATHER_PRESETS, isPresetWeather, formatCustomTime } from '@/lib/format'
import { AlertTriangle } from 'lucide-react'
import { t } from '@/i18n'

type Preview = {
  time?: string
  location?: string
  weather?: string
  scene_summary?: string
  details?: string[]
  character_states?: Record<string, Record<string, string>>
  /** 初始化调用失败时后端带回的原因（例如未配置 API Key），仅用于提示。 */
  error?: string
}

function isValidISO(s?: string): boolean {
  // 只有带“年份”且可被解析的才算结构化时间；其余（如 7/16 5:00 / 世界标准时 7/16/5:00）走自定义。
  if (!s) return false
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(s).trim())) return false
  return !Number.isNaN(new Date(s).getTime())
}

/** 在世界书地点树里找到与当前地点匹配的最深节点链，返回完整的「大区 › … › 详细」路径。 */
function expandLocationPath(locs: WorldLocation[], current: string): string {
  if (!current) return current
  const needle = String(current).trim()
  let best: string[] | null = null
  const walk = (nodes: WorldLocation[], path: string[]): void => {
    for (const node of nodes || []) {
      const name = (node.name || '').trim()
      if (!name) continue
      const nd = [...path, name]
      if (name && (needle.includes(name) || name.includes(needle))) {
        if (!best || nd.length > (best as string[]).length) best = nd
      }
      walk(node.children || [], nd)
    }
  }
  walk(locs || [], [])
  if (best) return (best as string[]).join(' › ')
  return current
}

export default function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp()
  const shell = useShell()
  const toast = useToast()
  const [worldbooks, setWorldbooks] = useState<LibraryWorldbook[]>([])
  const [chars, setChars] = useState<LibraryCharacter[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [identities, setIdentities] = useState<IdentityItem[]>([])
  const [selWb, setSelWb] = useState<Set<string>>(new Set())
  const [selChar, setSelChar] = useState<Set<string>>(new Set())
  const [selIdentity, setSelIdentity] = useState('')
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [name, setName] = useState('')
  const [hint, setHint] = useState('')
  const [detailText, setDetailText] = useState('')
  const [detailFocused, setDetailFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'setup' | 'preview'>('setup')
  const [sid, setSid] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [expandedWb, setExpandedWb] = useState<Set<string>>(new Set())
  const [showAllTags, setShowAllTags] = useState(false)
  const [timeMode, setTimeMode] = useState<'select' | 'custom'>('select')
  const [weatherMode, setWeatherMode] = useState<'preset' | 'custom'>('preset')
  const [locTree, setLocTree] = useState<WorldLocation[]>([])
  const [l1, setL1] = useState('')
  const [l2, setL2] = useState('')
  const [l3, setL3] = useState('')
  const [locOpen, setLocOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!open) return
    setExpandedWb(new Set())
    setShowAllTags(false)
    getLibraryWorldbooks().then((r) => {
      setWorldbooks(r.worldbooks)
      // 只有一本世界书时，自动勾选，减少创建会话的操作
      if (r.worldbooks.length === 1) {
        setSelWb(new Set([r.worldbooks[0].id]))
      } else if (r.worldbooks.length === 0) {
        setSelWb(new Set())
      }
    })
    getLibraryCharacterTags().then((r) => setTags(r.tags))
    listIdentities().then((r) => {
      setIdentities(r.identities)
      if (!r.identities.some((i) => i.id === selIdentity) && r.identities[0]) setSelIdentity(r.identities[0].id)
    })
  }, [open])

  useEffect(() => {
    getLibraryCharacters(q, tag).then((r) => setChars(r.characters))
  }, [q, tag])

  // “环境细节（每行一条）”用草稿承载，避免按回车时被 filter(Boolean) 吞掉空行。
  useEffect(() => {
    if (!detailFocused) setDetailText((preview?.details ?? []).join('\n'))
  }, [preview?.details, detailFocused])

  useEffect(() => {
    const parts = [l1, l2, l3].filter(Boolean)
    if (parts.length) patchPreview('location', parts.join('-'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l1, l2, l3])

  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    fn(next)
  }

  const toggleWbExpand = (id: string) =>
    setExpandedWb((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const initialize = async () => {
    setBusy(true)
    try {
      if (selWb.size === 0) { toast.push(t('请至少选择一本世界书'), '', 'error'); return }
      const r = await createSession(name || t('新会话'), [...selWb], [...selChar], selIdentity, hint)
      setSid(r.session.id)
      const init = await initSession(r.session.id, hint)
      setPreview(init.preview as Preview)
      const pv = init.preview as Preview
      setTimeMode(isValidISO(pv.time) ? 'select' : 'custom')
      setWeatherMode(isPresetWeather(pv.weather ?? '') ? 'preset' : 'custom')
      setL1(''); setL2(''); setL3(''); setLocOpen(false)
      getSessionWorldbooks().then(async (r) => {
        const trees: WorldLocation[] = []
        for (const wb of r.worldbooks) {
          try {
            const d = await getSessionWorldbook(wb.id)
            const raw = d.worldbook as Record<string, unknown>
            const locs = (raw?.locations as WorldLocation[]) || []
            if (Array.isArray(locs)) trees.push(...locs)
          } catch { /* ignore */ }
        }
        setLocTree(trees)
      }).catch(() => setLocTree([]))
      setPhase('preview')
      if (pv.error) {
        toast.push(t('开场生成失败'), pv.error, 'error')
      } else {
        toast.push(t('已生成开场预览'), t('可修改后确认开始'), 'success')
      }
    } catch (e) {
      toast.push(t('初始化失败'), String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const confirmStart = async () => {
    if (!sid || !preview) return
    setBusy(true)
    try {
      await startSession(sid, preview)
      await app.loadSession()
      toast.push(t('会话已开始'), '', 'success')
      onClose()
    } catch (e) {
      toast.push(t('开始失败'), String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const patchPreview = (k: keyof Preview, v: unknown) => setPreview((p) => (p ? { ...p, [k]: v } : p))

  // 初始化预览：把模型返回的“详细地点”展开成完整路径（大区 › … › 详细），与环境面板一致。
  useEffect(() => {
    if (!locTree.length || !preview?.location) return
    const expanded = expandLocationPath(locTree, preview.location)
    if (expanded && expanded !== preview.location) {
      patchPreview('location', expanded)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locTree])

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true)
    try {
      const snap = JSON.parse(await file.text())
      const r = await importSnapshot(snap)
      app.applyState(r.state)
      shell.setActiveSession(r.session.id)
      await shell.loadSessions()
      shell.setView('main')
      toast.push(t('已从存档文件导入新会话'), t('可直接继续，无需角色卡或世界书'), 'success')
      onClose()
    } catch (e) {
      toast.push(t('导入失败'), t('文件不是有效的存档？'), 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(97vw,1120px)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{phase === 'setup' ? t('新建会话') : t('开场预览')}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-2">
          {phase === 'setup' && (
            <>
              <div className="flex gap-2">
                <Input className="h-11 flex-1" placeholder={t("会话名称（例如：阿拜多斯的一天）")} value={name} onChange={(e) => setName(e.target.value)} />
                <Button className="shrink-0" variant="outline" onClick={() => fileRef.current?.click()} disabled={importing}>
                  {importing ? t('导入中…') : t('📥 导入存档')}
                </Button>
                <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onImportFile} />
              </div>

              <div>
                <div className="mb-2 text-sm font-semibold text-violet-700 dark:text-violet-200">{t('① 选择世界书（可多选）')}</div>
                <div className="grid grid-cols-2 gap-2.5">
                  {worldbooks.map((wb) => (
                    <div key={wb.id} className={`cursor-pointer rounded-xl border px-4 py-3 ${selWb.has(wb.id) ? 'border-fuchsia-400/60 bg-primary/10' : 'border-border/60 bg-background/40'}`} onClick={() => toggle(selWb, wb.id, setSelWb)}>
                      <div className="flex items-start gap-2"><span className="min-w-0 text-base font-semibold leading-snug">{wb.name}</span>{selWb.has(wb.id) && <Badge className="mt-1 text-[11px]">{t('已选')}</Badge>}</div>
                      <div className="mt-1 text-sm leading-snug text-muted-foreground">
                        <span
                          className={expandedWb.has(wb.id) ? '' : 'line-clamp-2'}
                          onClick={(e) => { e.stopPropagation(); toggleWbExpand(wb.id) }}
                        >
                          {wb.overview}
                        </span>
                        <button
                          type="button"
                          className="ml-1 text-xs text-violet-600 dark:text-violet-300 hover:underline"
                          onClick={(e) => { e.stopPropagation(); toggleWbExpand(wb.id) }}
                        >
                          {expandedWb.has(wb.id) ? t('收起') : t('展开')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm font-semibold text-violet-700 dark:text-violet-200">{t('② 玩家身份')}</div>
                <div className="flex flex-wrap items-center gap-2">
                  {identities.map((it) => (
                    <button key={it.id} onClick={() => setSelIdentity(it.id)}
                      className={`rounded-full px-4 py-1.5 text-sm ${selIdentity === it.id ? 'bg-fuchsia-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}>
                      {it.name}
                    </button>
                  ))}
                  {identities.length === 0 && (
                    <span className="text-sm text-muted-foreground">{t('暂无可用身份，请先在“资源库 → 身份卡”中创建。')}</span>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm font-semibold text-violet-700 dark:text-violet-200">{t('③ 选择角色（搜索 / 标签，多选）')}</div>
                <Input className="h-10" placeholder={t("搜索角色…")} value={q} onChange={(e) => setQ(e.target.value)} />
                <div className="mt-2 flex flex-wrap gap-1.5 pb-1">
                  {(showAllTags ? tags : tags.slice(0, 8)).map((t) => (
                    <button key={t} onClick={() => setTag(tag === t ? '' : t)}
                      className={`rounded-full px-3 py-1 text-xs ${tag === t ? 'bg-fuchsia-500 text-white' : 'bg-muted text-muted-foreground'}`}>{t}</button>
                  ))}
                  {tags.length > 8 && (
                    <button
                      type="button"
                      onClick={() => setShowAllTags((v) => !v)}
                      className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted/50"
                    >
                      {showAllTags ? t('收起') : `+${tags.length - 8}${t(' 更多')}`}
                    </button>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">{t('当前显示 {shown} 个 · 已选 {selected} 个', { shown: chars.length, selected: selChar.size })}</div>
                  <div className="flex gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => setSelChar(new Set(chars.map((c) => c.id)))}>{t('全选当前结果')}</Button>
                    <Button size="xs" variant="ghost" onClick={() => setSelChar(new Set())}>{t('清空已选')}</Button>
                  </div>
                </div>
                <div className="mt-2 grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1">
                  {chars.map((c) => (
                    <div key={c.id} className={`cursor-pointer rounded-xl border px-3 py-2.5 ${selChar.has(c.id) ? 'border-fuchsia-400/60 bg-primary/10' : 'border-border/60 bg-background/40'}`} onClick={() => toggle(selChar, c.id, setSelChar)}>
                      <div className="flex items-start gap-2"><span className="min-w-0 text-sm font-semibold leading-snug">{c.name}</span>{selChar.has(c.id) && <Badge className="mt-1 text-[11px]">{t('已选')}</Badge>}</div>
                      <div className="mt-1 text-xs leading-snug text-muted-foreground">{(c.tags || []).join(' / ')}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm font-semibold text-violet-700 dark:text-violet-200">{t('④ 开场提示（会发生什么）')}</div>
                <Textarea rows={3} className="text-base" placeholder={t("例如：在阿拜多斯自治区，遇到正在晨跑的砂狼白子。")} value={hint} onChange={(e) => setHint(e.target.value)} />
              </div>

              <Button size="lg" className="w-full" onClick={initialize} disabled={busy}>
                {busy ? t('正在生成开场…') : `${t('✨ 初始化（已选 ')}${selChar.size}${t(' 角色）')}`}
              </Button>
            </>
          )}

          {phase === 'preview' && preview && (
            <div className="space-y-3">
              {preview.error && (
                <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-200">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('开场没能由模型生成')}
                  </div>
                  <p className="mt-1 break-all whitespace-pre-wrap text-xs text-amber-800/90 dark:text-amber-100/90">
                    {preview.error}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 border-amber-500/50 text-amber-800 hover:bg-amber-500/10 dark:text-amber-100"
                    onClick={() => { onClose(); useShell.getState().openSettings('connection') }}
                  >
                    {t('去设置 API Key')}
                  </Button>
                  <p className="mt-2 text-xs text-amber-800/80 dark:text-amber-100/80">
                    {t('也可以直接手动填写下面的时间 / 地点 / 天气与背景，直接开始（之后补上 Key 仍可正常对话）。')}
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t('天气')}</span>
                    <span className="text-xl">{weatherEmoji(preview.weather ?? '')}</span>
                  </div>
                  <div className="flex gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
                    <Button size="sm" variant={weatherMode === 'preset' ? 'default' : 'ghost'} className="flex-1 px-2 py-0.5 text-xs" onClick={() => setWeatherMode('preset')}>{t('预设')}</Button>
                    <Button size="sm" variant={weatherMode === 'custom' ? 'default' : 'ghost'} className="flex-1 px-2 py-0.5 text-xs" onClick={() => setWeatherMode('custom')}>{t('自定义')}</Button>
                  </div>
                  {weatherMode === 'preset' ? (
                    <div className="flex flex-wrap gap-1.5">
                      {WEATHER_PRESETS.map((w) => (
                        <button key={w} onClick={() => patchPreview('weather', w)}
                          className={`rounded-full px-3 py-1 text-xs ${preview.weather === w ? 'bg-fuchsia-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}>
                          {w}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Input placeholder={t("自定义天气（对不上图标则无图标）")} value={preview.weather ?? ''} onChange={(e) => patchPreview('weather', e.target.value)} />
                  )}
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t('时间')}</span>
                  </div>
                  <div className="flex gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
                    <Button size="sm" variant={timeMode === 'select' ? 'default' : 'ghost'} className="flex-1 px-2 py-0.5 text-xs" onClick={() => setTimeMode('select')}>{t('选择')}</Button>
                    <Button size="sm" variant={timeMode === 'custom' ? 'default' : 'ghost'} className="flex-1 px-2 py-0.5 text-xs" onClick={() => setTimeMode('custom')}>{t('自定义')}</Button>
                  </div>
                  {timeMode === 'select' ? (
                    <Input type="datetime-local" value={(preview.time ?? '').slice(0, 16)} onChange={(e) => { const v = e.target.value; patchPreview('time', v ? (v.length === 16 ? `${v}:00` : v) : '') }} />
                  ) : (
                    <>
                      <Input placeholder={t("例如：3023 年、神历 314 年秋、未知…")} value={preview.time ?? ''} onChange={(e) => patchPreview('time', e.target.value)} />
                      {formatCustomTime(preview.time ?? '').ok && (
                        <span className="text-xs text-green-600 dark:text-green-400" title={t("该时间格式化成功")}>
                          {t('✓ 该时间格式化成功')}
                        </span>
                      )}
                      <p className="text-xs text-amber-600 dark:text-amber-400">{t('⚠️ 自定义时间可能无法自动更新。')}</p>
                    </>
                  )}
                </div>
                <div className="col-span-2">
                  <label className="block text-sm"><span className="text-muted-foreground">{t('地点')}</span><Input className="mt-1.5" value={preview.location ?? ''} onChange={(e) => patchPreview('location', e.target.value)} /></label>
                  {locTree.length > 0 && (
                    <div className="mt-2 rounded-lg border border-dashed border-border/70 p-2">
                      <button type="button" className="text-xs text-violet-600 dark:text-violet-300 hover:underline" onClick={() => setLocOpen((v) => !v)}>
                        {locOpen ? t('收起') : t('从世界书选择地点（可选）')}
                      </button>
                      {locOpen && (
                        <div className="mt-2 grid grid-cols-3 gap-1.5">
                          <select className="h-8 rounded-md border border-border/60 bg-background px-1 text-xs" value={l1}
                            onChange={(e) => { setL1(e.target.value); setL2(''); setL3('') }}>
                            <option value="">{t('一级')}</option>
                            {locTree.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
                          </select>
                          <select className="h-8 rounded-md border border-border/60 bg-background px-1 text-xs" value={l2}
                            onChange={(e) => { setL2(e.target.value); setL3('') }} disabled={!locTree.find((n) => n.name === l1)}>
                            <option value="">{t('二级')}</option>
                            {(locTree.find((n) => n.name === l1)?.children ?? []).map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
                          </select>
                          <select className="h-8 rounded-md border border-border/60 bg-background px-1 text-xs" value={l3}
                            onChange={(e) => setL3(e.target.value)} disabled={!locTree.find((n) => n.name === l1)?.children.find((n) => n.name === l2)}>
                            <option value="">{t('三级')}</option>
                            {((locTree.find((n) => n.name === l1)?.children.find((n) => n.name === l2)?.children) ?? []).map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <label className="block text-sm"><span className="text-muted-foreground">{t('背景')}</span><Textarea className="mt-1.5" rows={2} value={preview.scene_summary ?? ''} onChange={(e) => patchPreview('scene_summary', e.target.value)} /></label>
              <label className="block text-sm"><span className="text-muted-foreground">{t('环境细节（每行一条）')}</span><Textarea className="mt-1.5 font-mono text-sm" rows={3} value={detailText} onFocus={() => setDetailFocused(true)} onBlur={() => setDetailFocused(false)} onChange={(e) => { setDetailText(e.target.value); patchPreview('details', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)) }} /></label>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-sm text-muted-foreground">{t('角色初始状态可在开始后在“世界面板 → 角色”中继续调整。')}</div>
              <div className="flex gap-2">
                <Button size="lg" variant="ghost" onClick={() => setPhase('setup')} disabled={busy}>{t('返回修改')}</Button>
                <Button size="lg" className="flex-1" onClick={confirmStart} disabled={busy}>{busy ? t('开始中…') : t('✓ 确认并开始')}</Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
