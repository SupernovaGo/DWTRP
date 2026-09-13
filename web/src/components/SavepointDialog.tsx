import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  listSnapshots,
  deleteSnapshot,
  loadSnapshot,
  exportSnapshot,
  importSnapshot,
  type SnapshotMeta,
} from '@/lib/api'
import { useToast } from '@/store/toastStore'
import { useShell } from '@/store/useShell'
import { useApp } from '@/store/appStore'

export default function SavepointDialog({ open, onClose, onLoaded }: { open: boolean; onClose: () => void; onLoaded?: () => void }) {
  const toast = useToast()
  const shell = useShell()
  const app = useApp()
  const [list, setList] = useState<SnapshotMeta[]>([])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      listSnapshots().then((r) => setList(r.snapshots)).catch((e) => toast.push('加载存档点失败', String(e), 'error'))
    }
  }, [open])

  const del = async (id: string) => {
    if (!window.confirm('确定删除这个存档点？')) return
    const r = await deleteSnapshot(id)
    setList(r.snapshots)
    toast.push('已删除存档点', '', 'success')
  }

  const load = async (id: string) => {
    if (!window.confirm('载入该存档点会新建一个会话并切换到它，继续吗？')) return
    setBusy(true)
    try {
      const r = await loadSnapshot(id)
      shell.setActiveSession(r.session.id)
      app.applyState(r.state)
      await shell.loadSessions()
      shell.setView('main')
      toast.push('已从存档点载入新会话', '角色、世界与记忆均为该时刻的数据', 'success')
      onClose()
      onLoaded?.()
    } catch (e) {
      toast.push('载入失败', String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const exportOne = async (id: string, name: string) => {
    const snap = await exportSnapshot(id)
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name || '存档'}__${id}.json`.replace(/[\\/:*?"<>|]/g, '_')
    a.click()
    URL.revokeObjectURL(url)
    toast.push('已导出存档文件', '对方可在“存档点 → 导入”中直接使用', 'success')
  }

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const snap = JSON.parse(await file.text())
      const r = await importSnapshot(snap)
      shell.setActiveSession(r.session.id)
      app.applyState(r.state)
      await shell.loadSessions()
      shell.setView('main')
      toast.push('已从存档文件导入新会话', '可直接继续，无需角色卡或世界书', 'success')
      onClose()
      onLoaded?.()
    } catch (e) {
      toast.push('导入失败', '文件不是有效的存档？', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,920px)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>💾 存档点</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <p className="text-sm text-muted-foreground">
            在历史消息上点击「存为存档点」即可创建；也可在此载入、导出、导入或删除。存档包含那一刻的**全部**数据（世界、角色、记忆、场景）。载入后会新建一个独立会话，可直接继续，不依赖原会话或资源库。
          </p>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy} className="w-full">
              {busy ? '处理中…' : '📥 导入存档文件'}
            </Button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onImportFile} />
          </div>

          <div className="mb-1 text-sm font-semibold text-violet-700 dark:text-violet-200">已有存档点（{list.length}）</div>
          {list.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">还没有存档点。</p>}
          {list.map((s) => (
            <div key={s.id} className="rounded-xl border border-border/60 bg-background/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-base font-medium">{s.label || '未命名存档'}</span>
                    {s.auto && <Badge variant="secondary">自动</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {s.created_at} · {s.characters} 角色 · 场景 {s.scene_index} 条
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" onClick={() => load(s.id)} disabled={busy}>载入</Button>
                  <Button size="sm" variant="ghost" onClick={() => exportOne(s.id, s.label)} disabled={busy}>导出</Button>
                  <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => del(s.id)}>删除</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
