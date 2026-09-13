import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'
export interface ToastItem {
  id: number
  title: string
  msg?: string
  kind: ToastKind
}

let n = 0

interface ToastStore {
  toasts: ToastItem[]
  push: (title: string, msg?: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
}

export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  push: (title, msg, kind = 'info') => {
    const id = ++n
    set((s) => ({ toasts: [...s.toasts, { id, title, msg, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
