import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  listDirectives,
  addDirective,
  editDirective,
  deleteDirective,
  type WorldDirective,
} from '@/lib/api'
import { useToast } from '@/store/toastStore'
import { cn } from '@/lib/utils'

export default function WorldDirectiveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [directives, setDirectives] = useState<WorldDirective[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const reload = () => listDirectives().then((r) => setDirectives(r.directives))

  useEffect(() => {
    if (open) {
      reload().catch((e) => toast.push('加载指令失败', String(e), 'error'))
      setEditing(null)
      setText('')
      setExpanded(new Set())
    }
  }, [open])

  const startEdit = (i: number) => {
    setEditing(i)
    setText(directives[i].text)
  }

  const resetForm = () => {
    setEditing(null)
    setText('')
  }

  const save = async () => {
    if (!text.trim()) {
      toast.push('请填写指令内容', '', 'error')
      return
    }
    try {
      const r = editing == null
        ? await addDirective({ text: text.trim(), start: '', end: '' })
        : await editDirective(editing, { text: text.trim(), start: '', end: '' })
      setDirectives(r.directives)
      resetForm()
      toast.push(editing == null ? '已添加世界指令' : '世界指令已更新', '', 'success')
    } catch (e) {
      toast.push('保存失败', String(e), 'error')
    }
  }

  const del = async (i: number) => {
    if (!window.confirm('确定删除这条世界指令？')) return
    const r = await deleteDirective(i)
    setDirectives(r.directives)
    if (editing === i) setEditing(null)
    toast.push('已删除世界指令', '', 'success')
  }

  const toggleExpand = (i: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,980px)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>🌍 世界指令</DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-2">
          {/* 左侧：新建 */}
          <div className="flex min-h-0 flex-col overflow-y-auto pr-1">
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
              <div className="mb-2 text-sm font-semibold text-violet-700 dark:text-violet-200">
                {editing == null ? '＋ 新增指令' : '✏️ 编辑指令'}
              </div>
              <Textarea
                className="min-h-36 resize-none text-base"
                placeholder="写一段话，决定未来一段时间的剧情总体走向。例如：和若藻约会，途中遇到一场突如其来的暴雨，两人在屋檐下躲雨，气氛逐渐暧昧……"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="mt-2 flex gap-2">
                <Button className="flex-1" onClick={save}>{editing == null ? '添加' : '保存修改'}</Button>
                {editing != null && <Button variant="ghost" onClick={resetForm}>取消编辑</Button>}
              </div>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              可同时存在多条指令，世界推进时会一并注入到各 Agent 的上下文里。
            </p>
          </div>

          {/* 右侧：已有指令 */}
          <div className="flex min-h-0 flex-col overflow-y-auto pr-1">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-violet-700 dark:text-violet-200">已有指令（{directives.length}）</span>
              <Badge variant="secondary">{directives.length} 条</Badge>
            </div>
            {directives.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">还没有世界指令，在左侧添加一条。</p>
            )}
            {directives.map((d, i) => (
              <div key={i} className="mb-2 rounded-xl border border-border/60 bg-background/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => toggleExpand(i)}
                    title={expanded.has(i) ? '收起' : '展开'}
                  >
                    <div
                      className={cn(
                        'whitespace-pre-wrap text-[15px] leading-relaxed',
                        expanded.has(i) ? '' : 'line-clamp-3',
                      )}
                    >
                      {d.text}
                    </div>
                    <span className="mt-0.5 inline-block text-xs text-muted-foreground">
                      {expanded.has(i) ? '收起' : '展开'}
                    </span>
                  </button>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(i)}>编辑</Button>
                    <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => del(i)}>删除</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
