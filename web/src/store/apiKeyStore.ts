import { create } from 'zustand'
import { getSettings } from '@/lib/api'

/**
 * DeepSeek API Key 的状态（全局共享）。
 *
 * 未配置 Key 时，对话 / 世界更新 / 记忆总结全部不可用，因此需要在前端多处
 * （顶栏、设置页、输入栏）给出显式提醒（感叹号 / 警示条）。
 * `mock` 为真表示后端运行在离线 mock 模式，此时不需要 Key，不提示。
 */
interface ApiKeyStore {
  loaded: boolean
  keySet: boolean
  mock: boolean
  /** Key 来源：'env' / '.env' / 'config.toml'（空串表示未配置） */
  source: string
  /** server/.env 的绝对路径（用于界面提示） */
  envFile: string
  envFileExists: boolean
  refresh: () => Promise<void>
  markSet: (value: boolean) => void
}

export const useApiKey = create<ApiKeyStore>((set) => ({
  loaded: false,
  keySet: false,
  mock: false,
  source: '',
  envFile: '',
  envFileExists: false,
  refresh: async () => {
    try {
      const r = await getSettings()
      set({
        loaded: true,
        keySet: Boolean(r.api_key_set),
        mock: Boolean(r.mock),
        source: r.api_key_source ?? '',
        envFile: r.env_file ?? '',
        envFileExists: Boolean(r.env_file_exists),
      })
    } catch {
      // 后端不可达时保持未加载状态（不误报“缺 Key”）
      set({ loaded: false })
    }
  },
  markSet: (value) =>
    set({ loaded: true, keySet: Boolean(value), source: value ? '.env' : '' }),
}))

/** 需要提醒「未配置 API Key」时为 true（已加载 + 未设置 + 非 mock 模式）。 */
export function useMissingApiKey(): boolean {
  return useApiKey((s) => s.loaded && !s.keySet && !s.mock)
}

/** 非组件环境（store 内部、事件回调）里判断是否需要拦截。 */
export function isApiKeyMissing(): boolean {
  const s = useApiKey.getState()
  return s.loaded && !s.keySet && !s.mock
}
