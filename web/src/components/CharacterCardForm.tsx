import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { avatarUrl } from '@/lib/format'
import { t } from '@/i18n'

type Card = Record<string, any>

const REQUIRED: Array<[string, string]> = [
  ['name', t('名字')],
  ['intro', t('简介')],
  ['personality', t('性格')],
  ['appearance', t('默认外观')],
]

interface Props {
  card: Card
  onChange: (next: Card) => void
  avatar: string
  onOpenAvatar: () => void
}

function Field({ label, value, onChange, rows = 1 }: {
  label: string
  value: string
  onChange: (v: string) => void
  rows?: number
}) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      {rows > 1 ? (
        <Textarea className="mt-1 min-h-10 w-full resize-none" rows={rows} value={value || ''}
          onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input className="mt-1 h-8" value={value || ''} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  )
}

function StringListField({ label, value, onChange }: {
  label: string
  value: string[]
  onChange: (v: string[]) => void
}) {
  // 用 draft 字符串承载输入：这样「按回车新建空行」时，空行不会因 filter(Boolean)
  // 被立刻吞掉；失焦后再把干净的非空数组回写给上层。
  const [draft, setDraft] = useState((value || []).join('\n'))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft((value || []).join('\n'))
  }, [value, focused])
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}{t('（每行一个）')}</span>
      <Textarea className="mt-1 min-h-16 w-full resize-none" rows={3}
        value={draft}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setDraft(e.target.value)
          onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))
        }} />
    </label>
  )
}

function RelationshipEditor({ value, onChange }: {
  value: any[]
  onChange: (v: any[]) => void
}) {
  const list = Array.isArray(value) ? value : []
  const setAt = (i: number, k: string, v: string) =>
    onChange(list.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t('关系网（target / 称呼 / 关系 / 好感度 / 详述）')}</span>
        <Button size="xs" variant="ghost" onClick={() => onChange([...list, { target: '', address: '', relation: '', affection: '', detail: '' }])}>
          <Plus className="size-3" /> {t('加一条')}
        </Button>
      </div>
      {list.map((r, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border border-border/60 bg-background/40 p-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Input className="h-7 text-xs" placeholder={t("对方名 target")} value={r.target ?? ''} onChange={(e) => setAt(i, 'target', e.target.value)} />
            <Input className="h-7 text-xs" placeholder={t("称呼 address")} value={r.address ?? ''} onChange={(e) => setAt(i, 'address', e.target.value)} />
            <Input className="h-7 text-xs" placeholder={t("关系 relation")} value={r.relation ?? ''} onChange={(e) => setAt(i, 'relation', e.target.value)} />
            <Input className="h-7 text-xs" placeholder={t("好感度 affection(0~1)")} value={r.affection ?? ''} onChange={(e) => setAt(i, 'affection', e.target.value)} />
          </div>
          <div className="flex items-start gap-1.5">
            <Input className="h-7 flex-1 text-xs" placeholder={t("详述 detail")} value={r.detail ?? ''} onChange={(e) => setAt(i, 'detail', e.target.value)} />
            <Button size="icon-xs" variant="ghost" className="text-red-500" onClick={() => onChange(list.filter((_, j) => j !== i))}>
              <X className="size-3" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

function SpeechStyleEditor({ value, onChange }: {
  value: any
  onChange: (v: any) => void
}) {
  const style = (value && typeof value === 'object') ? value : {}
  const patch = (k: string, v: any) => onChange({ ...style, [k]: v })
  return (
    <div className="space-y-2">
      <Field label={t("描述 description")} value={style.description ?? ''} rows={2} onChange={(v) => patch('description', v)} />
      <StringListField label={t("示例 examples")} value={style.examples ?? []} onChange={(v) => patch('examples', v)} />
    </div>
  )
}

export default function CharacterCardForm({ card, onChange, avatar, onOpenAvatar }: Props) {
  const [recOpen, setRecOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)

  const set = (k: string, v: any) => onChange({ ...card, [k]: v })

  const recommendedKeys = ['surname', 'aliases', 'speech_style', 'relationships']
  const nonStandard = Object.keys(card).filter((k) =>
    !['id', 'name', 'intro', 'personality', 'appearance', 'tags', 'is_core', 'avatar']
      .includes(k) && !recommendedKeys.includes(k))

  const addCustom = () => {
    const k = window.prompt(t('自定义字段名（英文键）'), 'custom_field')
    if (!k) return
    set(k, '')
  }

  const recFilled = [...recommendedKeys, 'avatar'].filter((k) => {
    const v = card[k]
    if (Array.isArray(v)) return v.length > 0
    if (v && typeof v === 'object') return Object.values(v).some((x) => !!x)
    return !!v
  }).length

  return (
    <div className="space-y-3">
      {/* 头像（推荐字段） */}
      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
        {avatar ? (
          <img src={avatarUrl(avatar)} alt={card.name ?? ''} className="h-12 w-12 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-lg font-bold text-white">
            {(card.name ?? '?').slice(0, 1)}
          </div>
        )}
        <div className="flex-1">
          <div className="text-sm font-semibold">{t('头像（推荐字段）')}</div>
          <p className="text-xs text-muted-foreground">{t('导入本地图片并裁剪方形区域。')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onOpenAvatar}>{t('导入头像')}</Button>
      </div>

      {/* 必填 */}
      <div className="space-y-2">
        {REQUIRED.map(([key, label]) => (
          <Field
            key={key}
            label={label}
            value={card[key] ?? ''}
            onChange={(v) => set(key, v)}
            rows={key === 'name' ? 1 : 3}
          />
        ))}
        <label className="block text-xs">
          <span className="text-muted-foreground">{t('标签 tags（逗号分隔）')}</span>
          <Input className="mt-1 h-8" value={(card.tags || []).join(',')}
            onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))} />
        </label>
        <label className="flex items-center justify-between text-xs">
          <span>{t('是否为核心角色 is_core')}</span>
          <Switch checked={Boolean(card.is_core)} onCheckedChange={(v) => set('is_core', v)} />
        </label>
      </div>

      {/* 推荐字段（默认折叠） */}
      <div className="rounded-lg border border-border/60">
        <button type="button" className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-200"
          onClick={() => setRecOpen((v) => !v)}>
          {recOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {t('推荐字段')}{recFilled > 0 ? <span className="ml-1 text-muted-foreground">{t('（已填 {n}）', { n: recFilled })}</span> : null}
        </button>
        {recOpen && (
          <div className="space-y-2 border-t border-border/60 p-2">
            <Field label={t("姓 surname")} value={card.surname ?? ''} onChange={(v) => set('surname', v)} />
            <StringListField label={t("别名 aliases")} value={card.aliases ?? []} onChange={(v) => set('aliases', v)} />
            <div className="rounded-lg border border-border/60 bg-background/40 p-2">
              <div className="mb-1 text-xs text-muted-foreground">{t('说话风格 speech_style')}</div>
              <SpeechStyleEditor value={card.speech_style} onChange={(v) => set('speech_style', v)} />
            </div>
            <RelationshipEditor value={card.relationships ?? []} onChange={(v) => set('relationships', v)} />
          </div>
        )}
      </div>

      {/* 自定义字段 */}
      <div className="rounded-lg border border-border/60">
        <button type="button" className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-200"
          onClick={() => setCustomOpen((v) => !v)}>
          {customOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {t('自定义字段（{n}）', { n: nonStandard.length })}
        </button>
        {customOpen && (
          <div className="space-y-2 border-t border-border/60 p-2">
            {nonStandard.map((k) => {
              const v = card[k]
              const isObj = typeof v === 'object' && v !== null
              return (
                <div key={k} className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    {isObj ? (
                      <Textarea className="min-h-10 w-full resize-none font-mono text-xs" rows={2}
                        value={JSON.stringify(v, null, 2)}
                        onChange={(e) => { try { set(k, JSON.parse(e.target.value)) } catch { /* ignore */ } }} />
                    ) : (
                      <Input className="h-8 text-xs" value={v ?? ''} onChange={(e) => set(k, e.target.value)} />
                    )}
                  </div>
                  <Button size="icon-xs" variant="ghost" className="text-red-500" onClick={() => {
                    const next = { ...card }
                    delete next[k]
                    onChange(next)
                  }}>
                    <X className="size-3" />
                  </Button>
                </div>
              )
            })}
            <Button size="xs" variant="outline" onClick={addCustom}><Plus className="size-3" /> {t('添加自定义字段')}</Button>
          </div>
        )}
      </div>
    </div>
  )
}
