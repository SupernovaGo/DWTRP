import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { EN } from './en'

export type Lang = 'zh' | 'en'

export const LANGUAGES: ReadonlyArray<{ value: Lang; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

/** 首次打开时按浏览器语言猜一个默认值（中文环境以外默认英文）。 */
function detectLang(): Lang {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator.language || '' : ''
    if (nav && !nav.toLowerCase().startsWith('zh')) return 'en'
  } catch {
    /* ignore */
  }
  return 'zh'
}

/** 允许用 `?lang=en` / `?lang=zh` 直接指定界面语言（分享链接、截图等场合很方便）。 */
function initialLang(): Lang {
  try {
    const q = (new URLSearchParams(window.location.search).get('lang') || '').toLowerCase()
    if (q.startsWith('en')) return 'en'
    if (q.startsWith('zh')) return 'zh'
  } catch {
    /* ignore */
  }
  return detectLang()
}

interface LangState {
  lang: Lang
  setLang: (l: Lang) => void
}

/**
 * 界面语言。默认中文，可在「设置 → 个性化 → 🌐 语言」里切换；选择持久化在浏览器。
 * 英文词条见 i18n/en.ts：键就是中文原文，缺翻译时自动回退到中文。
 */
export const useLang = create<LangState>()(
  persist(
    (set) => ({
      lang: initialLang(),
      setLang: (lang) => set({ lang }),
    }),
    { name: 'lang' },
  ),
)

export function currentLang(): Lang {
  return useLang.getState().lang
}

/** 纯函数翻译，支持 `t('共 {n} 条', { n: 3 })` 形式的插值。 */
export function translate(lang: Lang, key: string, params?: Record<string, unknown>): string {
  let text = lang === 'en' ? EN[key] ?? key : key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split('{' + name + '}').join(String(value))
    }
  }
  return text
}

/** 非组件环境（store / 事件回调 / 工具函数）里使用。 */
export function t(key: string, params?: Record<string, unknown>): string {
  return translate(currentLang(), key, params)
}

export type TFn = (key: string, params?: Record<string, unknown>) => string

/** 组件里使用：语言切换时自动重渲染。 */
export function useT(): TFn {
  const lang = useLang((s) => s.lang)
  return useMemo<TFn>(() => (key, params) => translate(lang, key, params), [lang])
}

/** 后端接口带上当前语言，便于服务端的提示/报错也用同一种语言。 */
export function langHeader(): Record<string, string> {
  return { 'X-TRPE-Lang': currentLang() }
}
