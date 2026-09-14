import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ChevronDownIcon, Trash2, PlusIcon, PencilIcon } from 'lucide-react'
import { useShell } from '@/store/useShell'
import { useApp } from '@/store/appStore'
import { useToast } from '@/store/toastStore'
import { switchSession, deleteSession, renameSession } from '@/lib/api'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export default function SessionMenu({ onNewSession }: { onNewSession: () => void }) {
  const shell = useShell()
  const app = useApp()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const current = shell.sessions.find((s) => s.id === shell.activeSession)

  const onSwitch = async (id: string) => {
    setOpen(false)
    try {
      const r = await switchSession(id)
      shell.setActiveSession(id)
      if (r.state) app.applyState(r.state)
      await shell.loadSessions()
      shell.setView('main')
    } catch (e) {
      toast.push(t('切换失败'), String(e), 'error')
    }
  }

  const onDelete = async (id: string) => {
    setOpen(false)
    if (!window.confirm(t('确定删除这个会话？此操作不可恢复。'))) return
    try {
      await deleteSession(id)
      await shell.loadSessions().then(async (active) => {
        if (active) {
          shell.setActiveSession(active)
          await app.loadSession()
        } else {
          shell.setActiveSession(null)
          await app.init()
        }
      })
      toast.push(t('已删除会话'), '', 'success')
    } catch (e) {
      toast.push(t('删除失败'), String(e), 'error')
    }
  }

  const startRename = (id: string, name: string) => {
    setRenamingId(id)
    setRenameText(name)
  }

  const commitRename = async (id: string) => {
    const name = renameText.trim()
    if (!name) {
      setRenamingId(null)
      return
    }
    try {
      await renameSession(id, name)
      await shell.loadSessions()
      setRenamingId(null)
      toast.push(t('已重命名会话'), '', 'success')
    } catch (e) {
      toast.push(t('重命名失败'), String(e), 'error')
    }
  }

  return (
    <div ref={ref} className="relative">
      <Button
        variant="outline"
        className="max-w-[7.5rem] justify-between gap-1.5 sm:max-w-[260px]"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{current?.name ?? t('选择会话')}</span>
        <ChevronDownIcon className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-[min(18rem,calc(100vw-2.5rem))] overflow-hidden rounded-xl border border-border/60 bg-popover p-1.5 shadow-xl sm:w-80">
          <div className="max-h-[340px] overflow-y-auto">
            {shell.sessions.length === 0 && (
              <p className="px-3 py-5 text-center text-sm text-muted-foreground">{t('还没有会话，点击“＋ 新建会话”创建。')}</p>
            )}
            {shell.sessions.map((s) => (
              <div
                key={s.id}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/60"
                onClick={() => onSwitch(s.id)}
              >
                <div className="min-w-0 flex-1">
                  {renamingId === s.id ? (
                    <input
                      className="w-full rounded border border-border/60 bg-background px-2 py-1 text-sm focus:outline-none"
                      value={renameText}
                      autoFocus
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(s.id) }
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      onBlur={() => commitRename(s.id)}
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{s.name}</span>
                        {s.is_active && <Badge className="text-[10px]">{t('当前')}</Badge>}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {t('{characters} 角色 · {worldbooks} 世界书', { characters: (s as any).characters ?? 0, worldbooks: ((s as any).worldbooks ?? []).length })}
                      </div>
                    </>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-violet-600 dark:hover:text-violet-300"
                    onClick={(e) => {
                      e.stopPropagation()
                      startRename(s.id, s.name)
                    }}
                    title={t("重命名会话")}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  {s.id !== 'default' && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-red-600 dark:text-red-400 hover:text-red-500 dark:text-red-300"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(s.id)
                      }}
                      title={t("删除会话")}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 border-t border-border/60 pt-1">
            <Button variant="ghost" className="w-full justify-start" onClick={() => { setOpen(false); onNewSession() }}>
              <PlusIcon className="size-4" />
              {t('新建会话')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
