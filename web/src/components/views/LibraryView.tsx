import { useEffect, useRef, useState } from 'react'
import { Trash2, Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  getLibraryWorldbooks,
  getLibraryWorldbook,
  putLibraryWorldbook,
  deleteLibraryWorldbook,
  getLibraryCharacters,
  getLibraryCharacterTags,
  getLibraryCharacter,
  putLibraryCharacter,
  deleteLibraryCharacter,
  listIdentities,
  upsertIdentity,
  deleteIdentity,
  getIdentity,
  type LibraryWorldbook,
  type LibraryCharacter,
  type IdentityItem,
} from '@/lib/api'
import { useToast } from '@/store/toastStore'
import AvatarCropDialog from '@/components/AvatarCropDialog'
import CharacterCardForm from '@/components/CharacterCardForm'
import { useNameDisplay, displayNameFor } from '@/store/nameDisplay'
import { Switch } from '@/components/ui/switch'
import { t } from '@/i18n'

type Section = 'worldbooks' | 'characters' | 'identities'

export default function LibraryView() {
  const [section, setSection] = useState<Section>('worldbooks')
  return (
    <div className="flex h-full flex-col p-5">
      <div className="mb-3 grid w-full max-w-md grid-cols-3 gap-1">
        {([['worldbooks', t('世界书')], ['characters', t('角色库')], ['identities', t('身份卡')]] as [Section, string][]).map(([k, l]) => (
          <Button key={k} variant={section === k ? 'default' : 'outline'} size="lg" onClick={() => setSection(k)}>{l}</Button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {section === 'worldbooks' && <WorldbooksSection />}
        {section === 'characters' && <CharactersSection />}
        {section === 'identities' && <IdentitiesSection />}
      </div>
    </div>
  )
}

function WorldbooksSection() {
  const toast = useToast()
  const [list, setList] = useState<LibraryWorldbook[]>([])
  const [sel, setSel] = useState('')
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const reload = () => getLibraryWorldbooks().then((r) => setList(r.worldbooks))
  useEffect(() => { reload() }, [])
  const open = async (id: string) => { setSel(id); const r = await getLibraryWorldbook(id); setText(JSON.stringify(r.worldbook, null, 2)) }
  const create = async () => {
    const id = `wb_${Date.now().toString(36)}`
    await putLibraryWorldbook(id, { id, name: t('新世界书'), overview: '', entries: [], locations: [] })
    reload()
    open(id)
    toast.push(t('已创建新世界书'), t('请填写后保存'), 'success')
  }
  const del = async (id: string) => {
    if (!window.confirm(t('确定删除这本世界书？此操作不可恢复。'))) return
    await deleteLibraryWorldbook(id)
    if (sel === id) { setSel(''); setText('') }
    reload()
    toast.push(t('已删除世界书'), '', 'success')
  }
  const save = async () => {
    try { await putLibraryWorldbook(sel, JSON.parse(text)); toast.push(t('世界书已保存'), '', 'success'); reload() }
    catch (e) { toast.push(t('保存失败（JSON 格式错误？）'), String(e), 'error') }
  }
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      const items = Array.isArray(data) ? data : (Array.isArray(data.worldbooks) ? data.worldbooks : [data])
      let n = 0
      for (const wb of items) {
        if (!wb || typeof wb !== 'object') continue
        // 只接受标准格式：必须有 name 与 overview
        if (typeof wb.name !== 'string' || !wb.name.trim() || typeof wb.overview !== 'string') continue
        const id = wb.id || `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        await putLibraryWorldbook(id, { ...wb, id, name: wb.name })
        n++
      }
      if (n === 0) { toast.push(t('导入失败'), t('文件中没有符合标准格式的世界书（需 name / overview）'), 'error'); return }
      toast.push(`${t('已导入 ')}${n}${t(' 本世界书')}`, '', 'success')
      reload()
    } catch (err) {
      toast.push(t('导入失败'), t('文件不是有效的世界书 JSON？'), 'error')
    }
  }
  return (
    <div className="grid h-full grid-cols-1 gap-4 overflow-y-auto pb-4 md:grid-cols-2 md:overflow-hidden">
      <div className="flex min-h-0 flex-col">
        <div className="mb-2 flex shrink-0 gap-2">
          <Button className="flex-1" variant="outline" onClick={create}>{t('＋ 新建世界书')}</Button>
          <Button className="flex-1" variant="outline" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> {t('导入')}</Button>
          <a href="/templates/worldbook.template.json" download className="inline-flex h-10 items-center gap-1 rounded-lg border border-border/60 px-3 text-sm text-muted-foreground hover:bg-background/60"><Download className="size-4" /> {t('模板')}</a>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onImport} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {list.map((wb) => (
          <div key={wb.id} className={`mb-2.5 cursor-pointer rounded-xl border px-4 py-3 ${sel === wb.id ? 'border-fuchsia-400/60 bg-primary/10' : 'border-border/60 bg-background/40'}`} onClick={() => open(wb.id)}>
            <div className="flex items-center gap-2 text-base font-semibold">
              <span className="min-w-0 truncate">{wb.name}</span>
              <Button size="icon-sm" variant="ghost" className="ml-auto text-red-600 dark:text-red-400 hover:text-red-500 dark:text-red-300" onClick={(e) => { e.stopPropagation(); del(wb.id) }} title={t("删除")}>
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="mt-0.5 truncate text-sm text-muted-foreground">{wb.overview}</div>
            <div className="text-xs text-muted-foreground">{t('{entries} 设定 · {locations} 地点', { entries: wb.entries, locations: wb.locations })}</div>
          </div>
        ))}
        </div>
      </div>
      {sel && (
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          <Textarea className="min-h-0 flex-1 w-full resize-none overflow-y-auto font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} />
          <Button className="sticky bottom-0 z-10 w-full bg-background/90 backdrop-blur" onClick={save}>{t('保存世界书')}</Button>
        </div>
      )}
    </div>
  )
}

function CharactersSection() {
  const toast = useToast()
  const nameDisp = useNameDisplay()
  const [list, setList] = useState<LibraryCharacter[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [sel, setSel] = useState('')
  const [card, setCard] = useState<Record<string, any> | null>(null)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [avatarOpen, setAvatarOpen] = useState(false)
  useEffect(() => { getLibraryCharacterTags().then((r) => setTags(r.tags)) }, [])
  useEffect(() => { getLibraryCharacters(q, tag).then((r) => setList(r.characters)) }, [q, tag])
  const open = async (id: string) => { setSel(id); const r = await getLibraryCharacter(id); setCard(r.card); setJsonText(JSON.stringify(r.card, null, 2)) }
  const create = async () => {
    const id = `char_${Date.now().toString(36)}`
    await putLibraryCharacter(id, { id, name: t('新角色'), intro: '', personality: '', appearance: '', tags: [], is_core: false })
    getLibraryCharacters(q, tag).then((r) => setList(r.characters))
    const r = await getLibraryCharacter(id)
    setSel(id)
    setCard(r.card)
    setJsonText(JSON.stringify(r.card, null, 2))
    toast.push(t('已创建新角色'), t('请填写后保存'), 'success')
  }
  const del = async (id: string) => {
    if (!window.confirm(t('确定删除这个角色？此操作不可恢复。'))) return
    await deleteLibraryCharacter(id)
    if (sel === id) { setSel(''); setCard(null) }
    getLibraryCharacters(q, tag).then((r) => setList(r.characters))
    toast.push(t('已删除角色'), '', 'success')
  }
  const save = async () => {
    if (!card) return
    let payload = card
    if (mode === 'json') {
      try { payload = JSON.parse(jsonText) } catch { toast.push(t('保存失败（JSON 格式错误）'), '', 'error'); return }
      setCard(payload)
    }
    try { await putLibraryCharacter(sel, payload); toast.push(t('角色已保存'), '', 'success'); getLibraryCharacters(q, tag).then((r) => setList(r.characters)) }
    catch (e) { toast.push(t('保存失败'), String(e), 'error') }
  }
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      const items = Array.isArray(data) ? data : (Array.isArray(data.characters) ? data.characters : [data])
      let n = 0
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue
        const name = raw.name || ''
        const id = raw.id || `char_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        // 只接受标准角色卡：name/intro/personality/appearance + tags + is_core
        const isStd = typeof name === 'string' && !!name.trim() &&
          typeof raw.intro === 'string' && typeof raw.personality === 'string' &&
          typeof raw.appearance === 'string' && Array.isArray(raw.tags) &&
          typeof raw.is_core === 'boolean'
        if (!isStd) continue
        await putLibraryCharacter(id, { ...raw, id })
        n++
      }
      if (n === 0) { toast.push(t('导入失败'), t('文件中没有符合标准格式的角色卡（需 name/intro/personality/appearance/tags/is_core）'), 'error'); return }
      toast.push(`${t('已导入 ')}${n}${t(' 张角色卡')}`, '', 'success')
      getLibraryCharacters(q, tag).then((r) => setList(r.characters))
    } catch (err) {
      toast.push(t('导入失败'), t('文件不是有效的角色卡 JSON？'), 'error')
    }
  }
  const avatar = (card?.avatar as string) || ''
  return (
    <div className="grid h-full grid-cols-1 gap-4 overflow-y-auto pb-4 md:grid-cols-2 md:overflow-hidden">
      <div className="flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2">
          <Input className="flex-1" placeholder={t("搜索角色…")} value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
            {t('显示姓')}
            <Switch size="sm" checked={nameDisp.showSurname} onCheckedChange={(v) => nameDisp.set({ showSurname: v })} />
          </label>
        </div>
        <div className="mt-2 flex shrink-0 gap-1 overflow-x-auto pb-1">
          {tags.map((t) => (
            <button key={t} onClick={() => setTag(tag === t ? '' : t)}
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${tag === t ? 'bg-fuchsia-500 text-white' : 'bg-muted text-muted-foreground'}`}>{t}</button>
          ))}
        </div>
        <div className="mt-2 flex shrink-0 gap-2">
          <Button className="flex-1" variant="outline" onClick={create}>{t('＋ 新建角色')}</Button>
          <Button className="flex-1" variant="outline" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> {t('导入')}</Button>
          <a href="/templates/character_card.template.json" download className="inline-flex h-10 items-center gap-1 rounded-lg border border-border/60 px-3 text-sm text-muted-foreground hover:bg-background/60"><Download className="size-4" /> {t('模板')}</a>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onImport} />
        </div>
        <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {list.map((c) => (
            <div key={c.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 ${sel === c.id ? 'border-fuchsia-400/60 bg-primary/10' : 'border-border/60 bg-background/40'}`} onClick={() => open(c.id)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{displayNameFor(c.name, c.surname, nameDisp.showSurname)}</span>
                  <Badge variant={c.is_core ? 'default' : 'secondary'} className="text-[10px]">{c.is_core ? t('核心') : t('普通')}</Badge>
                  <Button size="icon-xs" variant="ghost" className="ml-auto text-red-600 dark:text-red-400 hover:text-red-500 dark:text-red-300" onClick={(e) => { e.stopPropagation(); del(c.id) }} title={t("删除")}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="truncate text-xs text-muted-foreground">{(c.tags || []).join(' / ')}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      {card && (
        <div className="flex min-h-0 flex-col space-y-2 overflow-y-auto">
          <div className="grid grid-cols-2 gap-1">
            <Button variant={mode === 'form' ? 'default' : 'outline'} size="sm" onClick={() => setMode('form')}>{t('表单')}</Button>
            <Button variant={mode === 'json' ? 'default' : 'outline'} size="sm" onClick={() => { if (card) setJsonText(JSON.stringify(card, null, 2)); setMode('json') }}>JSON</Button>
          </div>
          {mode === 'form' ? (
            <CharacterCardForm card={card} onChange={setCard} avatar={avatar} onOpenAvatar={() => setAvatarOpen(true)} />
          ) : (
            <Textarea className="min-h-[260px] w-full resize-none overflow-y-auto font-mono text-sm" value={jsonText} onChange={(e) => { setJsonText(e.target.value); try { setCard(JSON.parse(e.target.value)) } catch { /* ignore */ } }} />
          )}
          <Button className="sticky bottom-0 z-10 w-full bg-background/90 backdrop-blur" onClick={save}>{t('保存角色')}</Button>
        </div>
      )}
      {card && (
        <AvatarCropDialog open={avatarOpen} onClose={() => setAvatarOpen(false)}
          defaultValue={avatar} onApply={(b64) => setCard((c) => (c ? { ...c, avatar: b64 } : c))} />
      )}
    </div>
  )
}

function IdentitiesSection() {
  const toast = useToast()
  const [items, setItems] = useState<IdentityItem[]>([])
  const [sel, setSel] = useState('')
  const [card, setCard] = useState<Record<string, any> | null>(null)
  const reload = () => listIdentities().then((r) => setItems(r.identities))
  useEffect(() => { reload() }, [])
  const open = async (id: string) => { setSel(id); const r = await getIdentity(id); setCard({ id: r.identity.id, name: r.identity.name, role: r.identity.role, description: r.identity.description }) }
  const save = async () => {
    if (!card) return
    try { await upsertIdentity(card); toast.push(t('身份卡已保存'), '', 'success'); reload() }
    catch (e) { toast.push(t('保存失败'), String(e), 'error') }
  }
  const newCard = () => { setSel(''); setCard({ id: '', name: '', role: '', description: '' }) }
  return (
    <div className="grid h-full grid-cols-1 gap-4 overflow-y-auto pb-4 md:grid-cols-2 md:overflow-hidden">
      <div className="min-h-0 space-y-1.5 overflow-y-auto pr-1">
        <Button className="w-full" variant="outline" onClick={newCard}>{t('+ 新建身份卡')}</Button>
        {items.map((it) => (
          <div key={it.id} className={`cursor-pointer rounded-xl border px-4 py-3 ${sel === it.id ? 'border-fuchsia-400/60 bg-primary/10' : 'border-border/60 bg-background/40'}`} onClick={() => open(it.id)}>
            <div className="text-base font-semibold">{it.name}</div>
            <div className="truncate text-sm text-muted-foreground">{it.role}</div>
          </div>
        ))}
      </div>
      {card && (
        <div className="flex min-h-0 flex-col space-y-2 overflow-y-auto">
          <Input className="h-10" placeholder={t("名称")} value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} />
          <Input className="h-10" placeholder={t("身份（可选）")} value={card.role} onChange={(e) => setCard({ ...card, role: e.target.value })} />
          <Textarea rows={5} placeholder={t("身份描述")} value={card.description} onChange={(e) => setCard({ ...card, description: e.target.value })} />
          <div className="flex gap-2">
            <Button className="sticky bottom-0 z-10 flex-1 bg-background/90 backdrop-blur" onClick={save}>{t('保存')}</Button>
            {sel && <Button variant="ghost" className="text-red-600 dark:text-red-400" onClick={async () => { if (!window.confirm(t('确定删除这张身份卡？'))) return; await deleteIdentity(sel); reload(); setSel(''); setCard(null); toast.push(t('已删除身份'), '', 'success') }}>{t('删除')}</Button>}
          </div>
        </div>
      )}
    </div>
  )
}
