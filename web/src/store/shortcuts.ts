import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FnId } from '@/lib/functions'

const ALL: FnId[] = [
  'world_directive',
  'savepoint',
  'ai_write',
  'ai_rewrite',
  'precise',
  'show_thought',
]

interface ShortcutState {
  shortcuts: FnId[]
  toggle: (id: FnId) => void
}

export const useShortcuts = create<ShortcutState>()(
  persist(
    (set) => ({
      shortcuts: ALL,
      toggle: (id) =>
        set((s) => ({
          shortcuts: s.shortcuts.includes(id)
            ? s.shortcuts.filter((x) => x !== id)
            : [...s.shortcuts, id],
        })),
    }),
    { name: 'shortcuts' },
  ),
)
