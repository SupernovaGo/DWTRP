import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { XIcon } from 'lucide-react'
import { t } from '@/i18n'

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

export function ChoiceField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <div className="flex gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={
              value === o.value
                ? 'flex-1 rounded-md bg-fuchsia-500 px-2 py-1 text-xs text-white'
                : 'flex-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60'
            }
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </label>
  )
}

// 只允许 HH:MM 的时间选择器
export function TimeField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Input type="time" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

// 支持多个 HH:MM 时间点
export function TimeListField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string[]
  onChange: (v: string[]) => void
}) {
  const add = () => onChange([...value, '12:00'])
  const setTime = (i: number, t: string) => onChange(value.map((x, j) => (j === i ? t : x)))
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i))
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <div className="space-y-1.5">
        {value.map((t, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input type="time" className="flex-1" value={t} onChange={(e) => setTime(i, e.target.value)} />
            <Button size="icon-xs" variant="ghost" className="text-muted-foreground" onClick={() => remove(i)}>
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button size="xs" variant="outline" onClick={add}>{t('＋ 添加时间点')}</Button>
      </div>
    </label>
  )
}

// 只允许日期+时间的输入，内部把秒补齐（YYYY-MM-DDTHH:MM -> ...:00）以保持 ISO
export function DateTimeField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const local = value ? value.slice(0, 16) : ''
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <Input
        type="datetime-local"
        value={local}
        onChange={(e) => {
          const raw = e.target.value
          onChange(raw ? (raw.length === 16 ? `${raw}:00` : raw) : '')
        }}
      />
    </label>
  )
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

export function toTimeList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && !!x.trim())
  if (typeof v === 'string') return v ? [v] : []
  return []
}

export function fromTimeList(v: string[]): string | string[] {
  const times = v.filter((x) => x.trim())
  if (times.length <= 1) return times[0] ?? ''
  return times
}
