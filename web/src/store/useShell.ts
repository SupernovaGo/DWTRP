import { create } from 'zustand'
import { listSessions, type SessionMeta } from '@/lib/api'

export type ShellView = 'main' | 'library' | 'settings' | 'logs'
export type SettingsSection = 'engine' | 'prompts' | 'env' | 'personal' | 'connection'

interface Shell {
  view: ShellView
  settingsSection: SettingsSection
  sessions: SessionMeta[]
  activeSession: string | null
  setView: (v: ShellView) => void
  setSettingsSection: (s: SettingsSection) => void
  /** 跳到「设置」页（可指定分组），用于「未配置 API Key」等提醒的跳转。 */
  openSettings: (section?: SettingsSection) => void
  loadSessions: () => Promise<string | null>
  setActiveSession: (id: string | null) => void
}

export const useShell = create<Shell>((set) => ({
  view: 'main',
  settingsSection: 'engine',
  sessions: [],
  activeSession: null,
  setView: (view) => set({ view }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  openSettings: (section) =>
    set((s) => ({ view: 'settings', settingsSection: section ?? s.settingsSection })),
  loadSessions: async () => {
    try {
      const r = await listSessions()
      const active = r.active_id ?? null
      set({ sessions: r.sessions, activeSession: active })
      return active
    } catch {
      set({ sessions: [], activeSession: null })
      return null
    }
  },
  setActiveSession: (id) => set({ activeSession: id }),
}))
