import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PlayerSegment } from '@/types'

interface ComposerState {
  precise: boolean
  defaultPrecise: boolean
  assistBusy: boolean
  setPrecise: (v: boolean) => void
  setDefaultPrecise: (v: boolean) => void
  setAssistBusy: (v: boolean) => void
  suggestion: { text: string; segments?: PlayerSegment[] } | null
  seq: number
  push: (s: { text: string; segments?: PlayerSegment[] }) => void
  clear: () => void
}

export const useComposer = create<ComposerState>()(
  persist(
    (set) => ({
      precise: false,
      defaultPrecise: false,
      assistBusy: false,
      setPrecise: (v) => set({ precise: v }),
      setDefaultPrecise: (v) => set({ defaultPrecise: v, precise: v }),
      setAssistBusy: (v) => set({ assistBusy: v }),
      suggestion: null,
      seq: 0,
      push: (s) => set((st) => ({ suggestion: s, seq: st.seq + 1 })),
      clear: () => set({ suggestion: null }),
    }),
    { name: 'composer', partialize: (s) => ({ defaultPrecise: s.defaultPrecise }) },
  ),
)
