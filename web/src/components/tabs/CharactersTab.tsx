import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Plus, Trash2, BrainCircuit, Share2, ImagePlus, ArrowLeft } from 'lucide-react'
import {
  getCharacter,
  updateCharacter,
  promoteCharacter,
  getLibraryCharacters,
  addSessionCharacter,
  removeSessionCharacter,
  type LibraryCharacter,
} from '@/lib/api'
import { useApp } from '@/store/appStore'
import { useToast } from '@/store/toastStore'
import type { CharacterDetail, CharacterListItem } from '@/types'
import { avatarUrl } from '@/lib/format'
import MemoryDetail from '@/components/MemoryDetail'
import RelationsView from '@/components/RelationsView'
import AvatarCropDialog from '@/components/AvatarCropDialog'
import { useNameDisplay, displayNameFor } from '@/store/nameDisplay'

type JsonValue = unknown

function CharacterAvatar({ name, avatar, size = 'md' }: { name: string; avatar?: string; size?: 'sm' | 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'h-12 w-12 text-lg' : size === 'sm' ? 'h-7 w-7 text-sm' : 'h-9 w-9 text-base'
  const src = avatarUrl(avatar)
  if (src) {
    return <img src={src} alt={name} className={`${cls} shrink-0 rounded-full object-cover`} />
  }
  return (
    <div className={`${cls} flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 font-bold text-white`}>
      {(name || '?').slice(0, 1)}
    </div>
  )
}

function EditField({ label, value, onChange }: {
  label: string
  value: JsonValue
  onChange: (v: JsonValue) => void
}) {
  if (typeof value === 'boolean') {
    return (
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="flex-1">{label}</span>
        <Switch checked={value} onCheckedChange={onChange} />
      </label>
    )
  }
  if (typeof value === 'number') {
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-muted-foreground">{label}</span>
        <Input type="number" value={String(value)} onChange={(e) => onChange(Number(e.target.value))} />
      </label>
    )
  }
  if (typeof value === 'string') {
    // 长文本（如简介/性格/外观）用多行 Textarea，避免单行横向滚动。
    const isLong = value.length > 40
    if (isLong) {
      const rows = Math.max(2, Math.min(8, Math.ceil(value.length / 40)))
      return (
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">{label}</span>
          <Textarea rows={rows} className="resize-y text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
        </label>
      )
    }
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-muted-foreground">{label}</span>
        <Input value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    )
  }
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Textarea
        rows={4}
        className="font-mono text-sm"
        value={value === undefined ? '' : JSON.stringify(value, null, 2)}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value))
          } catch { /* keep old value while editing */ }
        }}
      />
    </label>
  )
}

function ObjectForm({ data, onChange }: {
  data: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  return (
    <div className="space-y-3">
      {Object.entries(data).map(([key, value]) => (
        <EditField key={key} label={key} value={value} onChange={(v) => onChange({ ...data, [key]: v })} />
      ))}
    </div>
  )
}

function CharacterEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast()
  const [detail, setDetail] = useState<CharacterDetail | null>(null)
  const [card, setCard] = useState<Record<string, unknown>>({})
  const [state, setState] = useState<Record<string, unknown>>({})
  const [planText, setPlanText] = useState('')
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<'form' | 'json' | 'plan'>('form')
  const [avatarOpen, setAvatarOpen] = useState(false)

  useEffect(() => {
    getCharacter(id).then((d) => {
      setDetail(d)
      setCard(d.card)
      setState(d.state)
      setPlanText(JSON.stringify(d.state?.current_plan ?? d.state?.plan ?? [], null, 2))
    })
  }, [id])

  const save = async () => {
    setSaving(true)
    try {
      let nextState = state
      if (mode === 'plan') {
        try {
          nextState = { ...state, current_plan: JSON.parse(planText || '{}') }
        } catch {
          toast.push('规划 JSON 格式错误', '请检查后重试', 'error')
          setSaving(false)
          return
        }
      }
      await updateCharacter(id, { card, state: nextState })
      const d = await getCharacter(id)
      setDetail(d)
      setCard(d.card)
      setState(d.state)
      setPlanText(JSON.stringify(d.state?.current_plan ?? d.state?.plan ?? [], null, 2))
      useApp.getState().refresh()
      toast.push('角色已保存', '', 'success')
    } catch (e) {
      toast.push('保存失败', String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const promote = async () => {
    try {
      await promoteCharacter(id)
      useApp.getState().refresh()
      const d = await getCharacter(id)
      setDetail(d)
      toast.push('已提升为核心角色', '', 'success')
    } catch (e) {
      toast.push('提升失败', String(e), 'error')
    }
  }

  const name = String((detail?.card?.name as string) ?? id)
  const avatar = (card['avatar'] as string) || ''

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,880px)] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CharacterAvatar name={name} avatar={avatar} size="sm" />
            {name}
            <Badge variant={detail?.is_core ? 'default' : 'secondary'}>{detail?.is_core ? '核心' : '普通'}</Badge>
            {!detail?.is_core && <Button size="sm" variant="outline" onClick={promote}>提升为核心</Button>}
          </DialogTitle>
        </DialogHeader>

        <div className="mb-2 grid shrink-0 grid-cols-3 gap-1">
          {(['form', 'json', 'plan'] as const).map((m) => (
            <Button key={m} variant={mode === m ? 'default' : 'outline'} size="sm" onClick={() => setMode(m)}>
              {m === 'form' ? '表单' : m === 'json' ? 'JSON' : '规划'}
            </Button>
          ))}
        </div>

        <div className="min-h-[400px] flex-1 overflow-y-auto pr-1">
          {mode === 'form' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
                <CharacterAvatar name={name} avatar={avatar} size="lg" />
                <div className="flex-1">
                  <div className="text-sm font-semibold">{name} 的头像</div>
                  <p className="text-xs text-muted-foreground">从本地选择图片并裁剪一个方形区域作为头像。</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setAvatarOpen(true)}>
                  <ImagePlus className="size-4" /> 导入头像
                </Button>
              </div>
              <ObjectForm data={card} onChange={setCard} />
            </div>
          )}
          {mode === 'json' && (
            <Textarea
              className="min-h-[320px] w-full font-mono text-sm"
              value={JSON.stringify(card, null, 2)}
              onChange={(e) => {
                try { setCard(JSON.parse(e.target.value)) } catch { /* ignore */ }
              }}
            />
          )}
          {mode === 'plan' && (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-violet-700 dark:text-violet-200">当前规划（时间范围 / 地点 / 做什么）</div>
              <Textarea
                className="min-h-[160px] w-full font-mono text-sm"
                value={planText}
                onChange={(e) => setPlanText(e.target.value)}
                placeholder='[{"time":"15:00 - 18:00","place":"地点","action":"做什么"}]'
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
      <AvatarCropDialog open={avatarOpen} onClose={() => setAvatarOpen(false)}
        defaultValue={avatar} onApply={(b64) => setCard((c) => ({ ...c, avatar: b64 }))} />
    </Dialog>
  )
}

function AddCharacterDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [list, setList] = useState<LibraryCharacter[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getLibraryCharacters(q).then((r) => setList(r.characters))
  }, [q])

  const add = async (id: string) => {
    setBusy(true)
    try {
      const r = await addSessionCharacter(id)
      useApp.getState().applyState(r.state)
      toast.push('已添加角色', '', 'success')
      onClose()
    } catch (e) {
      toast.push('添加失败', String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] w-[min(96vw,760px)] overflow-hidden">
        <DialogHeader><DialogTitle>添加角色到会话</DialogTitle></DialogHeader>
        <Input placeholder="搜索角色…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {list.map((c) => (
            <button key={c.id} disabled={busy} onClick={() => add(c.id)}
              className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-sm font-bold text-white">
                {c.name.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{c.name}</div>
                <div className="truncate text-xs text-muted-foreground">{c.intro}</div>
              </div>
              <Plus className="size-4 shrink-0 text-violet-500" />
            </button>
          ))}
          {list.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的角色。</p>}
        </div>
        <DialogFooter><Button variant="ghost" onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ViewState =
  | { type: 'list' }
  | { type: 'memory'; id: string; name: string }
  | { type: 'relations'; id: string; name: string }

export default function CharactersTab() {
  const appState = useApp((s) => s.appState)
  const toast = useToast()
  const nameDisp = useNameDisplay()
  const [view, setView] = useState<ViewState>({ type: 'list' })
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const chars: CharacterListItem[] = appState?.characters ?? []
  const filtered = q ? chars.filter((c) => c.name.includes(q) || c.id.includes(q)) : chars

  const remove = async (c: CharacterListItem) => {
    if (!window.confirm(`确定从会话中移除「${c.name}」？\n其状态与记忆也会一并删除。`)) return
    try {
      const r = await removeSessionCharacter(c.id)
      useApp.getState().applyState(r.state)
      toast.push('已移除角色', '', 'success')
    } catch (e) {
      toast.push('移除失败', String(e), 'error')
    }
  }

  if (view.type === 'memory') {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={() => setView({ type: 'list' })}><ArrowLeft className="size-4" /> 返回</Button>
          <h3 className="text-base font-semibold text-violet-700 dark:text-violet-200">💭 {displayNameFor(view.name, chars.find((c) => c.id === view.id)?.surname, nameDisp.showSurname)} 的记忆</h3>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden"><MemoryDetail cid={view.id} /></div>
      </div>
    )
  }

  if (view.type === 'relations') {
    return (
      <div className="h-full overflow-hidden">
        <RelationsView focusName={view.name} onBack={() => setView({ type: 'list' })}
          onFocus={(name) => {
            const target = chars.find((c) => c.name === name)
            if (target) setView({ type: 'relations', id: target.id, name: target.name })
          }} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col p-2.5">
      <div className="flex shrink-0 items-center justify-between">
        <h3 className="text-sm font-semibold text-violet-700 dark:text-violet-200">👥 会话角色（{chars.length}）</h3>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
            显示姓
            <Switch size="sm" checked={nameDisp.showSurname} onCheckedChange={(v) => nameDisp.set({ showSurname: v })} />
          </label>
          <Button size="xs" variant="outline" onClick={() => setAdding(true)}><Plus className="size-3" /> 添加</Button>
        </div>
      </div>
      <Input className="mt-1.5 shrink-0 h-7 text-sm" placeholder="搜索角色…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {filtered.map((c) => (
          <Card key={c.id} className="border-border/60 bg-background/40">
            <CardContent className="flex items-center gap-2 px-2.5 py-1.5">
              <CharacterAvatar name={displayNameFor(c.name, c.surname, nameDisp.showSurname)} avatar={c.avatar} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{displayNameFor(c.name, c.surname, nameDisp.showSurname)}</span>
                  <Badge variant={c.is_core ? 'default' : 'secondary'} className="text-[9px]">{c.is_core ? '核心' : '普通'}</Badge>
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{c.intro || c.location || '（无描述）'}</div>
                {(c.doing || c.location) && (
                  <div className="truncate text-[10px] text-violet-500/80">
                    {c.doing ? `规划：${c.doing}${c.location ? ` @ ${c.location}` : ''}` : `地点：${c.location}`}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="xs" variant="outline" className="px-1.5" onClick={() => setEditing(c.id)}>角色卡</Button>
                <Button size="xs" variant="outline" className="px-1.5" title="查看记忆" onClick={() => setView({ type: 'memory', id: c.id, name: c.name })}>
                  <BrainCircuit className="size-3" /> 记忆
                </Button>
                <Button size="xs" variant="outline" className="px-1.5" title="查看关系网" onClick={() => setView({ type: 'relations', id: c.id, name: c.name })}>
                  <Share2 className="size-3" /> 关系
                </Button>
                <Button size="icon-xs" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => remove(c)} title="移除角色">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {filtered.length === 0 && <p className="pt-6 text-center text-xs text-muted-foreground">没有匹配的角色。</p>}
      </div>
      {editing && <CharacterEditor id={editing} onClose={() => setEditing(null)} />}
      {adding && <AddCharacterDialog onClose={() => setAdding(false)} />}
    </div>
  )
}

