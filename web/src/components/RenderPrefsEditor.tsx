import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useRenderPrefs, SEG_LABELS, type SegKind } from '@/store/renderPrefs'
import { useUiDisplay } from '@/store/uiDisplay'
import { t } from '@/i18n'

const KINDS: SegKind[] = ['speech', 'action', 'think']

export default function RenderPrefsEditor() {
  const prefs = useRenderPrefs()
  const uiDisplay = useUiDisplay()
  const bubbleDelay = useRenderPrefs((s) => s.bubbleDelayMs)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {KINDS.map((kind) => {
          const st = prefs[kind]
          return (
            <div key={kind} className="rounded-xl border border-border/60 bg-background/40 p-3">
              <div className="mb-2 text-sm font-semibold text-violet-700 dark:text-violet-300">{t(SEG_LABELS[kind])}</div>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t('颜色')}</span>
                <input
                  type="color"
                  value={st.color}
                  onChange={(e) => prefs.set(kind, { color: e.target.value })}
                  className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent"
                />
                <Input className="h-8" value={st.color} onChange={(e) => prefs.set(kind, { color: e.target.value })} />
              </label>
              <label className="mt-2 flex items-center justify-between text-sm">
                <span>{t('加粗')}</span>
                <Switch checked={st.bold} onCheckedChange={(v) => prefs.set(kind, { bold: v })} />
              </label>
              <label className="mt-1 flex items-center justify-between text-sm">
                <span>{t('斜体')}</span>
                <Switch checked={st.italic} onCheckedChange={(v) => prefs.set(kind, { italic: v })} />
              </label>
            </div>
          )
        })}
      </div>
      <div className="flex gap-2">
        <div className="flex-1 text-sm text-muted-foreground">{t('这些样式会实时应用到故事面板中的角色与玩家的（说话 / 动作 / 思考）渲染。')}</div>
        <Button variant="outline" onClick={() => prefs.reset()}>{t('恢复默认')}</Button>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 p-3">
        <div className="mb-1 text-sm font-semibold text-violet-700 dark:text-violet-300">{t('💬 气泡间隔')}</div>
        <p className="mb-2 text-xs text-muted-foreground">{t('角色有多条子消息时，每条出现的间隔。0 = 一次性全部出现。')}</p>
        <UiSlider label={t("间隔(毫秒)")} value={bubbleDelay} min={0} max={1500} step={50}
          onChange={(v) => prefs.setBubbleDelay(v)} />
        <div className="mt-1 text-xs text-muted-foreground">{t('当前：{v} ms', { v: bubbleDelay })}</div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 p-3">
        <div className="mb-1 text-sm font-semibold text-violet-700 dark:text-violet-300">{t('🖥️ 界面可见度')}</div>
        <p className="mb-2 text-xs text-muted-foreground">{t('在深色模式下，降低边框/次要文字的可见度会影响阅读。这里可调高让按钮与文字更清晰。')}</p>
        <UiSlider label={t("边框 / 按钮明显度")} value={uiDisplay.borderAlpha} min={0.08} max={0.5} step={0.01}
          onChange={(v) => uiDisplay.set({ borderAlpha: v })} />
        <UiSlider label={t("次要文字亮度")} value={uiDisplay.textAlpha} min={0.4} max={1} step={0.01}
          onChange={(v) => uiDisplay.set({ textAlpha: v })} />
        <div className="mt-2 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => uiDisplay.reset()}>{t('恢复默认')}</Button>
          <span className="text-xs text-muted-foreground">{t('当前值：边框 {border} · 文字 {text}', { border: uiDisplay.borderAlpha.toFixed(2), text: uiDisplay.textAlpha.toFixed(2) })}</span>
        </div>
      </div>

    </div>
  )
}

function UiSlider({ label, value, min, max, step, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="mb-3 flex items-center gap-3 text-sm">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-fuchsia-500" />
      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{value.toFixed(2)}</span>
    </div>
  )
}
