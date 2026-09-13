import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface UiDisplayState {
  /** 边框/按钮可见度：0.08 ~ 0.5 */
  borderAlpha: number
  /** 次要文字亮度：0.4 ~ 1.0 */
  textAlpha: number
  set: (p: Partial<Pick<UiDisplayState, 'borderAlpha' | 'textAlpha'>>) => void
  reset: () => void
}

export const UI_DISPLAY_DEFAULTS = {
  borderAlpha: 0.18,
  textAlpha: 0.72,
}

export const useUiDisplay = create<UiDisplayState>()(
  persist(
    (set) => ({
      ...UI_DISPLAY_DEFAULTS,
      set: (p) => set((s) => ({ ...s, ...p })),
      reset: () => set({ ...UI_DISPLAY_DEFAULTS }),
    }),
    { name: 'ui-display' },
  ),
)

export function applyUiDisplay(s: UiDisplayState) {
  const root = document.documentElement
  root.style.setProperty('--ui-border-alpha', String(s.borderAlpha))
  root.style.setProperty('--ui-text-alpha', String(s.textAlpha))
}
