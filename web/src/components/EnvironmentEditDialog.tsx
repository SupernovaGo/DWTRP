import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useApp } from '@/store/appStore'
import { useToast } from '@/store/toastStore'
import { updatePerception, advancePerceptionTime, getSessionWorldbooks, getSessionWorldbook } from '@/lib/api'
import { weatherEmoji, WEATHER_PRESETS, isPresetWeather, formatCustomTime } from '@/lib/format'
import type { WorldLocation } from '@/types'

function isValidISO(iso?: string): boolean {
  // 只有明确带年份（YYYY-...）才算“结构化时间”，避免 `5/20` 被当作当前年日期。
  return !!iso && /^\d{4}-\d{2}-\d{2}/.test(String(iso).trim())
}

export default function EnvironmentEditDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const appState = useApp((s) => s.appState)
  const toast = useToast()
  const [timeMode, setTimeMode] = useState<'select' | 'custom'>('select')
  const [selectTime, setSelectTime] = useState('')
  const [customTime, setCustomTime] = useState('')
  const [weatherMode, setWeatherMode] = useState<'preset' | 'custom'>('preset')
  const [weather, setWeather] = useState('晴朗')
  const [customWeather, setCustomWeather] = useState('')
  const [location, setLocation] = useState('')
  const [details, setDetails] = useState('')
  const [sceneChars, setSceneChars] = useState<{ name: string; isolated?: boolean }[]>([])
  const [sceneCharInput, setSceneCharInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [locTree, setLocTree] = useState<WorldLocation[]>([])
  const [l1, setL1] = useState('')
  const [l2, setL2] = useState('')
  const [l3, setL3] = useState('')
  const [locOpen, setLocOpen] = useState(false)

  useEffect(() => {
    if (!open || !appState) return
    const valid = isValidISO(appState.clock)
    setTimeMode(valid ? 'select' : 'custom')
    setSelectTime(valid ? appState.clock.slice(0, 16) : '')
    setCustomTime(valid ? '' : appState.clock || '')
    const w = appState.weather || ''
    setWeatherMode(isPresetWeather(w) ? 'preset' : 'custom')
    setWeather(isPresetWeather(w) ? w : '晴朗')
    setCustomWeather(isPresetWeather(w) ? '' : w)
    setLocation(appState.location || '')
    setDetails((appState.perception?.details ?? [])
      .map((d) => (typeof d === 'string' ? d : (d?.text ?? '')))
      .join('\n'))
    setSceneChars((appState.perception?.scene_characters ?? []).map((c) => ({ name: c.name, isolated: !!c.isolated })))
    setSceneCharInput('')
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
  }, [open])

  const save = async () => {
    setSaving(true)
    try {
      const time = timeMode === 'select'
        ? (selectTime ? (selectTime.length === 16 ? `${selectTime}:00` : selectTime) : null)
        : (customTime.trim() || null)
      const weatherValue = weatherMode === 'preset' ? weather : (customWeather.trim() || null)
      const r = await updatePerception({
        time,
        weather: weatherValue,
        location: location.trim() || null,
        details: details.split('\n').map((d) => d.trim()).filter(Boolean),
        scene_characters: sceneChars,
      })
      useApp.getState().applyState(r.state)
      toast.push('环境已更新', '', 'success')
      onClose()
    } catch (e) {
      toast.push('保存失败', String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const advance = async () => {
    setSaving(true)
    try {
      const r = await advancePerceptionTime()
      useApp.getState().applyState(r.state)
      toast.push('时间已推进', '', 'success')
      onClose()
    } catch (e) {
      toast.push('推进失败', String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const l1Node = locTree.find((n) => n.name === l1)
  const l2Node = l1Node?.children.find((n) => n.name === l2)
  useEffect(() => {
    const parts = [l1, l2, l3].filter(Boolean)
    if (parts.length) setLocation(parts.join('-'))
  }, [l1, l2, l3])
  const pickLocation = () => {
    const parts = [l1, l2, l3].filter(Boolean)
    if (parts.length) setLocation(parts.join('-'))
  }

  const addSceneChar = () => {
    const name = sceneCharInput.trim()
    if (!name) return
    if (!sceneChars.some((c) => c.name === name)) {
      setSceneChars((arr) => [...arr, { name, isolated: false }])
    }
    setSceneCharInput('')
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,560px)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>✏️ 编辑环境</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">天气</Label>
              <span className="text-xl">{weatherEmoji(weatherMode === 'preset' ? weather : customWeather)}</span>
            </div>
            <div className="flex gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
              <Button size="sm" variant={weatherMode === 'preset' ? 'default' : 'ghost'} className="flex-1" onClick={() => setWeatherMode('preset')}>预设</Button>
              <Button size="sm" variant={weatherMode === 'custom' ? 'default' : 'ghost'} className="flex-1" onClick={() => setWeatherMode('custom')}>自定义</Button>
            </div>
            {weatherMode === 'preset' ? (
              <div className="flex flex-wrap gap-1.5">
                {WEATHER_PRESETS.map((w) => (
                  <button key={w} onClick={() => setWeather(w)}
                    className={`rounded-full px-3 py-1 text-xs ${weather === w ? 'bg-fuchsia-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}>
                    {w}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <Input placeholder="输入自定义天气（如图标对不上则不显示）" value={customWeather} onChange={(e) => setCustomWeather(e.target.value)} />
                {!weatherEmoji(customWeather) && customWeather && (
                  <Badge variant="outline" className="text-[11px] text-muted-foreground">该天气无法匹配图标</Badge>
                )}
              </>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">时间</Label>
              <Badge variant="outline" className="text-[11px] text-muted-foreground">非标准时间会影响自动更新</Badge>
            </div>
            <div className="flex gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
              <Button size="sm" variant={timeMode === 'select' ? 'default' : 'ghost'} className="flex-1" onClick={() => setTimeMode('select')}>结构化选择</Button>
              <Button size="sm" variant={timeMode === 'custom' ? 'default' : 'ghost'} className="flex-1" onClick={() => setTimeMode('custom')}>自定义</Button>
            </div>
            {timeMode === 'select' ? (
              <Input type="datetime-local" value={selectTime} onChange={(e) => setSelectTime(e.target.value)} />
            ) : (
              <>
                <Input placeholder="例如：3023 年、神历 314 年秋、未知…" value={customTime} onChange={(e) => setCustomTime(e.target.value)} />
                {formatCustomTime(customTime).ok && (
                  <span className="text-xs text-green-600 dark:text-green-400" title="该时间格式化成功">
                    ✓ 该时间格式化成功
                  </span>
                )}
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ 自定义时间通常无法被自动解析，世界和角色可能无法自动更新，需手动推进。
                </p>
              </>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">地点</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例如：夏莱办公室" />
            {locTree.length > 0 && (
              <div className="rounded-lg border border-dashed border-border/70 p-2">
                <button type="button" className="text-xs text-violet-600 dark:text-violet-300 hover:underline" onClick={() => setLocOpen((v) => !v)}>
                  {locOpen ? '收起' : '从世界书选择地点（可选）'}
                </button>
                {locOpen && (
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    <select className="h-8 rounded-md border border-border/60 bg-background px-1 text-xs" value={l1}
                      onChange={(e) => { setL1(e.target.value); setL2(''); setL3('') }}>
                      <option value="">一级</option>
                      {locTree.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
                    </select>
                    <select className="h-8 rounded-md border border-border/60 bg-background px-1 text-xs" value={l2}
                      onChange={(e) => { setL2(e.target.value); setL3('') }} disabled={!l1Node}>
                      <option value="">二级</option>
                      {(l1Node?.children ?? []).map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
                    </select>
                    <select className="h-8 rounded-md border border-border/60 bg-background px-1 text-xs" value={l3}
                      onChange={(e) => setL3(e.target.value)} disabled={!l2Node}>
                      <option value="">三级</option>
                      {(l2Node?.children ?? []).map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
                    </select>
                  </div>
                )}
                {(l1 || l2 || l3) && (
                  <Button size="xs" variant="outline" className="mt-1.5" onClick={pickLocation}>使用该地点</Button>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">环境信息（每行一条）</Label>
            <Textarea className="min-h-24 font-mono text-sm" value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder={'例如：\n窗外的灯光昏暗\n桌上散落着几份文件'} />
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">场景角色（当前与玩家同处一地的角色）</Label>
            <div className="space-y-1.5">
              {sceneChars.map((c, i) => (
                <div key={`${c.name}-${i}`} className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/40 px-2 py-1 text-sm">
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={!!c.isolated}
                      onChange={(e) => setSceneChars((arr) => arr.map((x, j) => (j === i ? { ...x, isolated: e.target.checked } : x)))}
                    />
                    隔离
                  </label>
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-red-500"
                    onClick={() => setSceneChars((arr) => arr.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="flex gap-1.5">
                <Input
                  placeholder="输入角色名字后添加"
                  value={sceneCharInput}
                  onChange={(e) => setSceneCharInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addSceneChar()
                    }
                  }}
                />
                <Button size="sm" variant="outline" onClick={addSceneChar}>添加</Button>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={advance} disabled={saving}>⏩ 手动推进时间</Button>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
