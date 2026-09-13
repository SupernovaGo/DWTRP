import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface NameDisplayState {
  /** 全局：是否显示姓（对话界面 / 会话角色列表 / 资源库角色列表共用） */
  showSurname: boolean
  set: (p: Partial<Pick<NameDisplayState, 'showSurname'>>) => void
}

export const useNameDisplay = create<NameDisplayState>()(
  persist(
    (set) => ({
      showSurname: false,
      set: (p) => set((s) => ({ ...s, ...p })),
    }),
    { name: 'name-display' },
  ),
)

/** 根据开关，把“名 / 姓 名”格式化成显示名。 */
export function displayNameFor(name: string, surname: string | undefined, showSurname: boolean): string {
  if (showSurname && surname) return `${surname} ${name}`
  return name
}
