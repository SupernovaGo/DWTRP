import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import SessionMenu from '@/components/SessionMenu'
import NewSessionDialog from '@/components/NewSessionDialog'
import ToastHost from '@/components/ToastHost'
import MainView from '@/components/views/MainView'
import LibraryView from '@/components/views/LibraryView'
import SettingsView from '@/components/views/SettingsView'
import LogsView from '@/components/views/LogsView'
import { useShell, type ShellView } from '@/store/useShell'
import { useApp } from '@/store/appStore'
import { useTheme } from '@/store/theme'
import { useUiDisplay, applyUiDisplay } from '@/store/uiDisplay'
import { useApiKey, useMissingApiKey } from '@/store/apiKeyStore'
import { cn } from '@/lib/utils'
import { switchSession } from '@/lib/api'
import { Sun, Moon, AlertTriangle } from 'lucide-react'

const TABS: [ShellView, string][] = [
  ['main', '主界面'],
  ['library', '资源库'],
  ['settings', '设置'],
  ['logs', '日志'],
]

function SessionLanding({ onNew }: { onNew: () => void }) {
  const shell = useShell()
  const app = useApp()
  const onSwitch = async (id: string) => {
    try {
      const r = await switchSession(id)
      shell.setActiveSession(id)
      if (r.state) app.applyState(r.state)
      await shell.loadSessions()
      shell.setView('main')
    } catch { /* ignore */ }
  }
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <div className="text-7xl">✨</div>
      <h1 className="mt-5 text-2xl font-semibold">TRPE</h1>
      <p className="mt-3 max-w-md text-base text-muted-foreground">
        从一个已有会话继续，或新建一个会话开始。
      </p>
      <Button size="lg" className="mt-6 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-6 text-base" onClick={onNew}>
        ＋ 新建会话
      </Button>
      {shell.sessions.length > 0 && (
        <div className="mt-8 w-full max-w-lg space-y-2.5">
          <div className="text-sm text-muted-foreground">已有会话（点击加载）</div>
          {shell.sessions.slice(0, 8).map((s) => (
            <div key={s.id} className="cursor-pointer rounded-xl border border-border/60 bg-background/40 px-5 py-3 text-left text-base hover:bg-background/60" onClick={() => onSwitch(s.id)}>
              <div className="font-medium">{s.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{(s as any).characters ?? 0} 角色 · {((s as any).worldbooks ?? []).length} 世界书</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const shell = useShell()
  const theme = useTheme((s) => s.theme)
  const toggleTheme = useTheme((s) => s.toggle)
  const ui = useUiDisplay()
  const missingKey = useMissingApiKey()
  const [newOpen, setNewOpen] = useState(false)

  useEffect(() => {
    // 启动即检查是否已配置 API Key（未配置时全局显示感叹号提醒）。
    void useApiKey.getState().refresh()
    shell.loadSessions().then((active) => {
      if (active) {
        useApp.getState().loadSession()
      }
    })
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    applyUiDisplay(ui)
  }, [ui.borderAlpha, ui.textAlpha])

  return (
    <div className={cn(
      'flex h-dvh flex-col overflow-hidden text-foreground',
      theme === 'dark'
        ? 'bg-gradient-to-br from-slate-950 via-[#140a26] to-[#0b0b12]'
        : 'bg-gradient-to-br from-violet-100 via-white to-fuchsia-100',
    )}>
      <header className="sticky top-0 z-40 flex min-h-14 shrink-0 flex-col border-b border-border/60 bg-background/70 backdrop-blur">
        <div className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-lg">✨</div>
          <span className="text-sm font-bold tracking-tight md:text-base">TRPE</span>
          <nav className="ml-3 hidden items-center gap-1.5 md:flex">
            {TABS.map(([v, label]) => (
              <button key={v} onClick={() => shell.setView(v)}
                className={cn('flex items-center gap-1 rounded-lg px-3.5 py-1.5 text-[15px] font-medium transition-colors',
                  shell.view === v ? 'bg-primary/20 text-violet-700 dark:text-violet-200' : 'text-muted-foreground hover:bg-background/60',
                  v === 'settings' && missingKey && shell.view !== v && 'text-amber-600 dark:text-amber-300')}>
                {label}
                {v === 'settings' && missingKey && (
                  <span className="flex size-4 items-center justify-center rounded-full bg-amber-500 text-[11px] font-bold text-white">!</span>
                )}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <SessionMenu onNewSession={() => setNewOpen(true)} />
            <Button variant="outline" className="hidden gap-1.5 md:inline-flex" onClick={() => setNewOpen(true)}>＋ 新建会话</Button>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full border border-border/60"
              onClick={toggleTheme}
              title={theme === 'dark' ? '切换浅色模式' : '切换深色模式'}
            >
              {theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
            </Button>
          </div>
        </div>
        <nav className="flex items-center gap-1.5 overflow-x-auto px-2 pb-2 md:hidden">
          {TABS.map(([v, label]) => (
            <button key={v} onClick={() => shell.setView(v)}
              className={cn('flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-[13px] font-medium transition-colors',
                shell.view === v ? 'bg-primary/20 text-violet-700 dark:text-violet-200' : 'text-muted-foreground hover:bg-background/60',
                v === 'settings' && missingKey && 'text-amber-600 dark:text-amber-300')}>
              {label}
              {v === 'settings' && missingKey && (
                <span className="flex size-4 items-center justify-center rounded-full bg-amber-500 text-[11px] font-bold text-white">!</span>
              )}
            </button>
          ))}
        </nav>

        {missingKey && (
          <div className="flex items-center gap-2 border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[13px] text-amber-800 dark:text-amber-100 md:px-4">
            <AlertTriangle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              尚未配置 DeepSeek API Key：对话、世界更新与记忆总结都无法使用。
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 border-amber-500/50 text-amber-800 hover:bg-amber-500/10 dark:text-amber-100"
              onClick={() => shell.openSettings('connection')}
            >
              去填写
            </Button>
          </div>
        )}
      </header>

      <section className="min-h-0 flex-1">
        {shell.view === 'main' && (
          shell.activeSession ? (
            <MainView />
          ) : (
            <SessionLanding onNew={() => setNewOpen(true)} />
          )
        )}
        {shell.view === 'library' && <LibraryView />}
        {shell.view === 'settings' && <SettingsView />}
        {shell.view === 'logs' && <LogsView />}
      </section>

      <NewSessionDialog open={newOpen} onClose={() => { setNewOpen(false); shell.loadSessions() }} />
      <ToastHost />
    </div>
  )
}
