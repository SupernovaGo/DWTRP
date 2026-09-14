import { useEffect, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Pencil } from 'lucide-react'
import { useApp } from '@/store/appStore'
import { useToast } from '@/store/toastStore'
import { getSessionWorldbooks, getSessionWorldbook, putSessionWorldbook, updateWorldSummary } from '@/lib/api'
import { parseClock } from '@/lib/format'
import { t } from '@/i18n'

export default function WorldTab() {
  const appState = useApp((s) => s.appState)
  const toast = useToast()
  const timeline = appState?.timeline ?? []
  const [wbList, setWbList] = useState<{ id: string; name: string }[]>([])
  const [sel, setSel] = useState('')
  const [text, setText] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [overview, setOverview] = useState('')
  const [background, setBackground] = useState('')
  const [tone, setTone] = useState('')

  useEffect(() => {
    getSessionWorldbooks().then((r) => setWbList(r.worldbooks))
  }, [])

  const open = async (id: string) => {
    setSel(id)
    const r = await getSessionWorldbook(id)
    setText(JSON.stringify(r.worldbook, null, 2))
  }
  const save = async () => {
    try {
      await putSessionWorldbook(sel, JSON.parse(text))
      toast.push(t('当前会话的这本世界书已保存'), '', 'success')
    } catch (e) {
      toast.push(t('保存失败（JSON 格式错误？）'), String(e), 'error')
    }
  }

  const openEdit = () => {
    const meta = appState?.world_meta ?? {}
    setOverview(meta.overview ?? '')
    setBackground(meta.background ?? '')
    setTone(meta.tone ?? '')
    setEditOpen(true)
  }

  const saveSummary = async () => {
    try {
      const r = await updateWorldSummary({ overview, background, tone })
      useApp.getState().applyState(r.state)
      toast.push(t('世界摘要已更新'), '', 'success')
      setEditOpen(false)
    } catch (e) {
      toast.push(t('保存失败'), String(e), 'error')
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      {wbList.length > 0 && (
        <Card className="shrink-0 border-border/60 bg-background/40">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-semibold text-violet-700 dark:text-violet-200">{t('本会话世界书（{n} 本）', { n: wbList.length })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {wbList.map((wb) => (
              <div key={wb.id} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${sel === wb.id ? 'border-fuchsia-400/60 bg-primary/10' : 'border-border/60 bg-background/40'}`}>
                <span className="cursor-pointer truncate" onClick={() => open(wb.id)}>{wb.name}</span>
                {sel !== wb.id && <Button size="xs" variant="ghost" className="px-2" onClick={() => open(wb.id)}>{t('查看/编辑')}</Button>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {sel && (
        <Card className="shrink-0 border-primary/30 bg-primary/5">
          <CardContent className="space-y-2 px-3 py-3">
            <Textarea className="h-[200px] w-full resize-none overflow-y-auto font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex gap-2">
              <Button className="flex-1" onClick={save}>{t('保存这本世界书')}</Button>
              <Button variant="ghost" onClick={() => setSel('')}>{t('收起')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="shrink-0 border-border/60 bg-background/40">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">{t('📖 世界摘要')}</CardTitle>
            <Button size="icon-sm" variant="ghost" className="h-7 w-7" onClick={openEdit} title={t("编辑世界摘要/背景")}>
              <Pencil className="size-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="max-h-40 overflow-y-auto">
          <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
            {appState?.world_summary || t('暂无世界信息')}
          </pre>
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={(o) => !o && setEditOpen(false)}>
        <DialogContent className="max-h-[92vh] w-[min(96vw,560px)] overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t('✏️ 编辑世界摘要 / 背景')}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="space-y-1">
              <Label className="text-sm text-muted-foreground">{t('概览（世界书摘要）')}</Label>
              <Textarea className="min-h-[80px] resize-y" value={overview} onChange={(e) => setOverview(e.target.value)} placeholder={t("世界的整体概况…")} />
            </div>
            <div className="space-y-1">
              <Label className="text-sm text-muted-foreground">{t('背景（当前会话情境）')}</Label>
              <Textarea className="min-h-[80px] resize-y" value={background} onChange={(e) => setBackground(e.target.value)} placeholder={t("本次会话开场的背景…")} />
            </div>
            <div className="space-y-1">
              <Label className="text-sm text-muted-foreground">{t('基调（可选）')}</Label>
              <Textarea className="min-h-[48px] resize-y" value={tone} onChange={(e) => setTone(e.target.value)} placeholder={t("世界基调，如：轻松日常 / 悬疑…")} />
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="ghost" onClick={() => setEditOpen(false)}>{t('取消')}</Button>
            <Button onClick={saveSummary}>{t('保存')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="flex min-h-[220px] flex-1 flex-col border-border/60 bg-background/40">
        <CardHeader className="shrink-0 pb-2">
          <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">{t('🕰️ 世界时间线')}</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full pr-2">
            {timeline.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('时间线为空，随世界推进生成。')}</p>
            ) : (
              <ol className="relative ml-2 space-y-3 border-l border-border pl-4">
                {timeline.map((ev) => (
                  <li key={ev.id} className="relative">
                    <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-400" />
                    <div className="text-xs text-muted-foreground">{parseClock(ev.time).date} {parseClock(ev.time).time}</div>
                    <div className="text-sm font-medium">{ev.place}</div>
                    <div className="text-sm text-muted-foreground">{ev.description}</div>
                  </li>
                ))}
              </ol>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
