import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface NoticeState {
  /** 是否显示记忆总结 / 世界更新 / 角色更新 / 记忆遗忘等后台通知。 */
  showNotices: boolean
  setShowNotices: (v: boolean) => void
}

export const useNotices = create<NoticeState>()(
  persist(
    (set) => ({
      showNotices: true,
      setShowNotices: (v) => set({ showNotices: v }),
    }),
    { name: 'notices', partialize: (s) => ({ showNotices: s.showNotices }) },
  ),
)
