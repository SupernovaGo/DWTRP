import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Theme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      setTheme: (t) => set({ theme: t }),
      toggle: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
    }),
    { name: 'theme' },
  ),
)
