import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CSSProperties } from 'react'

export type SegKind = 'speech' | 'action' | 'think'

export interface RenderStyle {
  color: string
  bold: boolean
  italic: boolean
}

export interface RenderPrefsState {
  speech: RenderStyle
  action: RenderStyle
  think: RenderStyle
  /** 角色多条子消息每条冒出的间隔（毫秒） */
  bubbleDelayMs: number
  set: (kind: SegKind, patch: Partial<RenderStyle>) => void
  setBubbleDelay: (v: number) => void
  reset: () => void
}

export const RENDER_DEFAULTS: Record<SegKind, RenderStyle> = {
  speech: { color: '#f5f3ff', bold: false, italic: false },
  action: { color: '#fb923c', bold: false, italic: true },
  think: { color: '#c4b5fd', bold: false, italic: false },
}

export const DEFAULT_BUBBLE_DELAY_MS = 500

export const SEG_LABELS: Record<SegKind, string> = {
  speech: '说话',
  action: '动作',
  think: '指令',
}

export const useRenderPrefs = create<RenderPrefsState>()(
  persist(
    (set) => ({
      ...RENDER_DEFAULTS,
      bubbleDelayMs: DEFAULT_BUBBLE_DELAY_MS,
      set: (kind, patch) =>
        set((s) => ({ ...s, [kind]: { ...s[kind], ...patch } })),
      setBubbleDelay: (v) => set({ bubbleDelayMs: Math.max(0, Math.min(3000, v || 0)) }),
      reset: () => set({ ...RENDER_DEFAULTS, bubbleDelayMs: DEFAULT_BUBBLE_DELAY_MS }),
    }),
    { name: 'render-prefs' },
  ),
)

function darkenForLight(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const num = parseInt(m[1], 16)
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  if (lum < 0.62) return hex // 已足够深，浅色模式下也清晰
  // 浅色模式下，把特亮的颜色压暗，保证在白色卡片/背景上可读。
  const f = 0.42
  const rr = Math.round(r * f)
  const gg = Math.round(g * f)
  const bb = Math.round(b * f)
  return `#${((rr << 16) | (gg << 8) | bb).toString(16).padStart(6, '0')}`
}

export function styleOf(kind: SegKind, prefs: RenderPrefsState, dark = true): CSSProperties {
  const st = prefs[kind]
  return {
    color: dark ? st.color : darkenForLight(st.color),
    fontWeight: st.bold ? 700 : 400,
    fontStyle: st.italic ? 'italic' : 'normal',
  }
}
