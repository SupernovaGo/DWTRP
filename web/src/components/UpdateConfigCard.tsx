import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { NumberField, TimeListField, toTimeList, fromTimeList } from '@/components/config-fields'

export default function UpdateConfigCard({
  config,
  onChange,
}: {
  config: Record<string, any>
  onChange: (next: Record<string, any>) => void
}) {
  const update = config.update ?? {}
  const world = config.world ?? {}
  const patchUpdate = (v: Record<string, unknown>) => onChange({ ...config, update: { ...update, ...v } })
  const patchWorld = (v: Record<string, unknown>) => onChange({ ...config, world: { ...world, ...v } })

  return (
    <Card className="border-border/60 bg-background/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">🔄 世界 / 角色更新</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <TimeListField label="更新时间" value={toTimeList(update.time)} onChange={(v) => patchUpdate({ time: fromTimeList(v) })} />
        <NumberField label="角色批次大小" value={update.batch_size ?? 10} min={1} max={50} onChange={(v) => patchUpdate({ batch_size: v })} />
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>更新顺序</span>
          <Select value={update.world_first ? 'world' : 'character'} onValueChange={(v) => patchUpdate({ world_first: v === 'world' })}>
            <SelectTrigger className="h-9 w-40" size="sm">
              <SelectValue placeholder="顺序" />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="world">世界在前</SelectItem>
              <SelectItem value="character">角色在前</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>更新时显示提示</span>
          <Switch checked={Boolean(update.notice)} onCheckedChange={(v) => patchUpdate({ notice: v })} />
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>允许手动推进时间</span>
          <Switch checked={Boolean(world.enable_manual_time_advance)} onCheckedChange={(v) => patchWorld({ enable_manual_time_advance: v })} />
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>允许手动更新世界 / 角色</span>
          <Switch checked={Boolean(update.enable_manual_update)} onCheckedChange={(v) => patchUpdate({ enable_manual_update: v })} />
        </label>
      </CardContent>
    </Card>
  )
}
