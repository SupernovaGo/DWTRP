import type {
  AppState,
  CharacterDetail,
  MemoryData,
  RelationGraph,
  SSEEvent,
} from '@/types'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
// 打包成桌面/移动 App 时可指向远程后端；默认走同域（开发时由 Vite 代理到 8000）。
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(BASE + url, init)
  if (!resp.ok) {
    let detail = ''
    try {
      const body = await resp.json()
      detail = body?.detail ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `${resp.status} ${resp.statusText}`)
  }
  return resp.json() as Promise<T>
}

export function fetchState(): Promise<AppState> {
  return request<AppState>('/api/state')
}

export function sendChat(text: string): Promise<{ state: AppState }> {
  return request('/api/chat', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  })
}

export function setThink(value: boolean): Promise<{ show_thought: boolean }> {
  return request('/api/state/think', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ value }),
  })
}

export function setStoryMode(enabled: boolean): Promise<{ ok: boolean; story_mode: boolean; state: AppState }> {
  return request('/api/session/story-mode', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ enabled }),
  })
}

export function updatePerception(partial: { time?: string | null; weather?: string | null; location?: string | null; details?: string[] | null; scene_characters?: { name: string; isolated?: boolean }[] | null }): Promise<{ ok: boolean; state: AppState }> {
  return request('/api/session/perception', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(partial),
  })
}

export function renameSession(sid: string, name: string): Promise<{ ok: boolean; session: SessionMeta }> {
  return request(`/api/sessions/${encodeURIComponent(sid)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
}

export function advancePerceptionTime(): Promise<{ ok: boolean; state: AppState }> {
  return request('/api/session/perception/advance', { method: 'POST' })
}

export function manualUpdate(target: 'world' | 'character'): Promise<{ ok: boolean; state: AppState }> {
  return request('/api/session/manual-update', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ target }),
  })
}

export function resetSession(): Promise<AppState> {
  return request('/api/session/reset', { method: 'POST' })
}

export function ackPendingUpdates(): Promise<{ ok: boolean }> {
  return request('/api/session/pending-updates/ack', { method: 'POST' })
}

export function assist(mode: 'write' | 'rewrite'): Promise<{ text: string; segments?: { type: string; text: string }[] | null; error?: string }> {
  return request('/api/assist', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ mode }),
  })
}

export function rewindLastTurn(): Promise<{
  ok: boolean
  error?: string
  player_message?: { name: string; text: string } | null
  events?: Record<string, unknown>[]
  state?: AppState
}> {
  return request('/api/assist/rewind', { method: 'POST' })
}

export async function streamRewind(onEvent: (ev: SSEEvent) => void): Promise<void> {
  const resp = await fetch(BASE + '/api/assist/rewind/stream', { method: 'POST' })
  if (!resp.ok || !resp.body) throw new Error('重写请求失败')
  await readEventStream(resp, onEvent)
}

export async function streamManualUpdate(
  target: 'world' | 'character',
  onEvent: (ev: SSEEvent) => void,
): Promise<void> {
  const resp = await fetch(BASE + '/api/session/manual-update/stream', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ target }),
  })
  if (!resp.ok || !resp.body) throw new Error('更新请求失败')
  await readEventStream(resp, onEvent)
}

async function readEventStream(resp: Response, onEvent: (ev: SSEEvent) => void): Promise<void> {
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            onEvent(JSON.parse(line.slice(6)) as SSEEvent)
          } catch {
            /* ignore malformed lines */
          }
        }
      }
    }
  }
}

export function getCharacters(): Promise<{ characters: AppState['characters'] }> {
  return request('/api/characters')
}

export function getCharacter(id: string): Promise<CharacterDetail> {
  return request(`/api/characters/${id}`)
}

export function updateCharacter(
  id: string,
  patch: { card?: Record<string, unknown>; state?: Record<string, unknown> },
): Promise<CharacterDetail> {
  return request(`/api/characters/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  })
}

export function promoteCharacter(id: string): Promise<{ ok: boolean }> {
  return request(`/api/characters/${id}/promote`, { method: 'POST' })
}

export function addSessionCharacter(id: string): Promise<{ ok: boolean; id: string; state: AppState }> {
  return request('/api/characters', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id }),
  })
}

export function removeSessionCharacter(cid: string): Promise<{ ok: boolean; state: AppState }> {
  return request(`/api/characters/${cid}`, { method: 'DELETE' })
}

export function getCharacterGraph(): Promise<RelationGraph> {
  return request('/api/characters/graph')
}

export function getMemory(id: string): Promise<MemoryData> {
  return request(`/api/characters/${id}/memory`)
}

export function deleteMemoryEvent(id: string, eventId: string): Promise<{ ok: boolean }> {
  return request(`/api/characters/${id}/memory/events/${eventId}`, { method: 'DELETE' })
}

export function addMemoryEvent(
  id: string,
  body: { summary: string; text?: string; importance?: number },
): Promise<{ ok: boolean; event_id: string }> {
  return request(`/api/characters/${id}/memory/events`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
}

export function getPrompts(): Promise<{ prompts: Record<string, string> }> {
  return request('/api/prompts')
}

export function updatePrompts(prompts: Record<string, string>): Promise<{ prompts: Record<string, string> }> {
  return request('/api/prompts', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ prompts }),
  })
}

export function getConfig(): Promise<{ config: Record<string, unknown> }> {
  return request('/api/config')
}

export function updateConfig(partial: Record<string, unknown>): Promise<{ ok: boolean; note: string }> {
  return request('/api/config', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ config: partial }),
  })
}

/** 只读取当前会话的配置覆盖（为空表示沿用全局设置）。 */
export function getSessionConfig(): Promise<{ config: Record<string, unknown> }> {
  return request('/api/session/config')
}

/** 保存当前会话的配置覆盖，仅作用于本会话。 */
export function updateSessionConfig(partial: Record<string, unknown>): Promise<{ ok: boolean; config: Record<string, unknown> }> {
  return request('/api/session/config', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ config: partial }),
  })
}

/**
 * 流式聊天：POST /api/chat/stream，解析 SSE，逐条回调 onEvent。
 */
export async function streamChat(
  text: string,
  onEvent: (ev: SSEEvent) => void,
  segments?: { type: string; text: string }[],
): Promise<void> {
  const resp = await fetch(BASE + '/api/chat/stream', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ text, segments }),
  })
  if (!resp.ok || !resp.body) {
    throw new Error('对话请求失败')
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            onEvent(JSON.parse(line.slice(6)) as SSEEvent)
          } catch {
            /* ignore malformed lines */
          }
        }
      }
    }
  }
}

// ---------- 会话 ----------
export interface SessionMeta {
  id: string
  name: string
  hint: string
  created_at: string
  status: string
  is_active?: boolean
}

export function listSessions(): Promise<{ sessions: SessionMeta[]; active_id: string }> {
  return request('/api/sessions')
}

export function createSession(
  name: string,
  worldbooks: string[],
  characters: string[],
  identity_id: string,
  hint: string,
): Promise<{ ok: boolean; session: SessionMeta }> {
  return request('/api/sessions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, worldbooks, characters, identity_id, hint }),
  })
}

export function initSession(id: string, hint: string): Promise<{ session: SessionMeta; preview: Record<string, any> }> {
  return request(`/api/sessions/${id}/initialize`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: '', hint }),
  })
}

export function startSession(id: string, init: Record<string, any>): Promise<{ ok: boolean; state: AppState }> {
  return request(`/api/sessions/${id}/start`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ init }),
  })
}

export function switchSession(id: string): Promise<{ ok: boolean; state: AppState }> {
  return request(`/api/sessions/${id}/switch`, { method: 'POST' })
}

export function deleteSession(id: string): Promise<{ ok: boolean; state: AppState }> {
  return request(`/api/sessions/${id}`, { method: 'DELETE' })
}

export function editHistory(index: number, text: string): Promise<{ ok: boolean; state: AppState }> {
  return request(`/api/session/history/${index}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ index, text }),
  })
}

export function editStoryHistory(
  sceneIndex: number,
  body: { text: string; directive?: string },
): Promise<{ ok: boolean; state: AppState }> {
  return request(`/api/session/story/${sceneIndex}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body),
  })
}

export function deleteHistory(index: number): Promise<{ ok: boolean; state: AppState }> {
  return request(`/api/session/history/${index}`, { method: 'DELETE' })
}

export function branchHistory(index: number): Promise<{ ok: boolean; state: AppState }> {
  return request('/api/session/history/branch', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ index }),
  })
}

// ---------- 世界指令 ----------
export interface WorldDirective {
  text: string
  start: string
  end: string
}

export function listDirectives(): Promise<{ directives: WorldDirective[] }> {
  return request('/api/session/directives')
}

export function addDirective(d: WorldDirective): Promise<{ ok: boolean; directives: WorldDirective[] }> {
  return request('/api/session/directives', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(d),
  })
}

export function editDirective(index: number, d: WorldDirective): Promise<{ ok: boolean; directives: WorldDirective[] }> {
  return request(`/api/session/directives/${index}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(d),
  })
}

export function deleteDirective(index: number): Promise<{ ok: boolean; directives: WorldDirective[] }> {
  return request(`/api/session/directives/${index}`, { method: 'DELETE' })
}

// ---------- 存档点 ----------
export interface SnapshotMeta {
  id: string
  label: string
  created_at: string
  auto: boolean
  scene_index: number
  characters: number
}

export function listSnapshots(): Promise<{ snapshots: SnapshotMeta[] }> {
  return request('/api/session/snapshots')
}

export function createSnapshot(label?: string): Promise<{ ok: boolean; snapshot: SnapshotMeta }> {
  return request('/api/session/snapshots', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ label: label ?? '' }),
  })
}

export function createSnapshotFromHistory(index: number, label?: string): Promise<{ ok: boolean; snapshot: SnapshotMeta }> {
  return request('/api/session/snapshots/from-history', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ index, label: label ?? '' }),
  })
}

export function deleteSnapshot(id: string): Promise<{ ok: boolean; snapshots: SnapshotMeta[] }> {
  return request(`/api/session/snapshots/${id}`, { method: 'DELETE' })
}

export function loadSnapshot(id: string): Promise<{ ok: boolean; session: SessionMeta; state: AppState }> {
  return request(`/api/session/snapshots/${id}/load`, { method: 'POST' })
}

export function exportSnapshot(id: string): Promise<Record<string, any>> {
  return request(`/api/session/snapshots/${id}/export`)
}

export function importSnapshot(snapshot: Record<string, any>): Promise<{ ok: boolean; session: SessionMeta; state: AppState }> {
  return request('/api/session/snapshots/import', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ snapshot }),
  })
}

// ---------- 身份卡 ----------
export interface IdentityItem {
  id: string
  name: string
  role: string
  description: string
  is_active?: boolean
}

export function listIdentities(): Promise<{ identities: IdentityItem[] }> {
  return request('/api/identities')
}

export function upsertIdentity(card: Partial<IdentityItem>): Promise<{ ok: boolean; identity: IdentityItem }> {
  return request('/api/identities', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(card),
  })
}

export function activateIdentity(id: string): Promise<{ ok: boolean }> {
  return request(`/api/identities/${id}/activate`, { method: 'POST' })
}

export function deleteIdentity(id: string): Promise<{ ok: boolean }> {
  return request(`/api/identities/${id}`, { method: 'DELETE' })
}

// ---------- 世界书 ----------
export function getWorldbook(): Promise<{ worldbook: Record<string, unknown> }> {
  return request('/api/worldbook')
}

export function putWorldbook(worldbook: Record<string, unknown>): Promise<{ ok: boolean }> {
  return request('/api/worldbook', {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ worldbook }),
  })
}

export function updateWorldSummary(body: {
  overview?: string
  background?: string
  tone?: string
}): Promise<{ ok: boolean; state: AppState }> {
  return request('/api/session/world-summary', {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body),
  })
}

// ---------- 资源库 ----------
export interface LibraryWorldbook {
  id: string
  name: string
  overview: string
  entries: number
  locations: number
}

export interface LibraryCharacter {
  id: string
  name: string
  surname?: string
  is_core: boolean
  tags: string[]
  intro: string
}

export function getLibraryWorldbooks(): Promise<{ worldbooks: LibraryWorldbook[] }> {
  return request('/api/library/worldbooks')
}

export function getLibraryWorldbook(id: string): Promise<{ worldbook: Record<string, any> }> {
  return request(`/api/library/worldbooks/${id}`)
}

export function putLibraryWorldbook(id: string, wb: Record<string, any>): Promise<{ ok: boolean }> {
  return request(`/api/library/worldbooks/${id}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ worldbook: wb }),
  })
}

export function deleteLibraryWorldbook(id: string): Promise<{ ok: boolean }> {
  return request(`/api/library/worldbooks/${id}`, { method: 'DELETE' })
}

export function getLibraryCharacters(q = '', tag = ''): Promise<{ characters: LibraryCharacter[] }> {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (tag) params.set('tag', tag)
  return request(`/api/library/characters?${params.toString()}`)
}

export function getLibraryCharacterTags(): Promise<{ tags: string[] }> {
  return request('/api/library/characters/tags')
}

export function getLibraryCharacter(id: string): Promise<{ card: Record<string, any> }> {
  return request(`/api/library/characters/${id}`)
}

export function putLibraryCharacter(id: string, card: Record<string, any>): Promise<{ ok: boolean }> {
  return request(`/api/library/characters/${id}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ card }),
  })
}

export function deleteLibraryCharacter(id: string): Promise<{ ok: boolean }> {
  return request(`/api/library/characters/${id}`, { method: 'DELETE' })
}

// ---------- 设置 / 日志 / 会话内世界书 ----------
export function getSettings(): Promise<{
  api_key_set: boolean
  /** Key 来源：env / .env / config.toml（空串表示未配置） */
  api_key_source?: string
  env_file?: string
  env_file_exists?: boolean
  mock: boolean
}> {
  return request('/api/settings')
}

export function setApiKey(key: string): Promise<{ ok: boolean }> {
  return request('/api/settings/apikey', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ key }),
  })
}

// ---------- 系统信息 / 手机远程关机 ----------
export function getSystemInfo(): Promise<{ ip: string; os: string }> {
  return request('/api/system/info')
}

// ---------- 运行环境（可选依赖 / 嵌入模型） ----------
export interface EnvTask {
  id: string
  kind: '' | 'install_embedding' | 'download_model'
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  detail: string
  log: string[]
  started_at: number
  ended_at: number
  running: boolean
}

export interface EnvStatus {
  python: {
    executable: string
    version: string
    major_minor: string
    in_venv: boolean
    prefix: string
    platform: string
  }
  requirements: boolean
  embedding: {
    enabled: boolean
    offline: boolean
    model_name: string
    deps_installed: boolean
    torch_version: string
    sentence_transformers_version: string
    deps_error: string
    model_cached: boolean
    model_path: string
    hf_home: string
    hf_endpoint: string
    ready: boolean
    loaded: boolean
    last_error: string
  }
  config: {
    enabled: boolean
    offline: boolean
    model_name: string
    hf_endpoint: string
    pip_index_url: string
  }
  task: EnvTask
}

/** 运行环境状态（refresh=true 时重新探测 torch / sentence-transformers）。 */
export function getEnvStatus(refresh = false): Promise<EnvStatus> {
  return request(`/api/env/status?refresh=${refresh ? 'true' : 'false'}`)
}

/** 后台安装可选依赖：torch + sentence-transformers（进度用 getEnvTask 轮询）。 */
export function installEmbeddingDeps(indexUrl = ''): Promise<{ ok: boolean; task_id: string }> {
  return request('/api/env/install-embedding', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ index_url: indexUrl }),
  })
}

/** 后台下载嵌入模型到 HuggingFace 缓存。 */
export function downloadEmbeddingModel(
  model = '',
  mirror = '',
): Promise<{ ok: boolean; task_id: string }> {
  return request('/api/env/download-model', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model, mirror }),
  })
}

export function getEnvTask(): Promise<EnvTask> {
  return request('/api/env/task')
}

export function cancelEnvTask(): Promise<{ ok: boolean; detail?: string }> {
  return request('/api/env/cancel', { method: 'POST' })
}

export function shutdownComputer(): Promise<{ ok: boolean; seconds: number }> {
  return request('/api/system/shutdown', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ confirm: true }),
  })
}

export function cancelShutdown(): Promise<{ ok: boolean; note?: string }> {
  return request('/api/system/shutdown/cancel', { method: 'POST' })
}

export interface LogSessionFile {
  name: string
  size: number
  date: string
  kind: string
}

export interface LogSession {
  id: string
  name: string
  files: LogSessionFile[]
}

export function getLogs(): Promise<{ sessions: LogSession[] }> {
  return request('/api/logs')
}

export function getLogContent(session: string, name: string): Promise<{ content: Record<string, any>[] }> {
  return request(`/api/logs/content?session=${encodeURIComponent(session)}&name=${encodeURIComponent(name)}`)
}

export function getSessionWorldbooks(): Promise<{ worldbooks: { id: string; name: string; world: string }[] }> {
  return request('/api/session/worldbooks')
}

export function getSessionWorldbook(id: string): Promise<{ worldbook: Record<string, any> }> {
  return request(`/api/session/worldbooks/${id}`)
}

export function putSessionWorldbook(id: string, wb: Record<string, any>): Promise<{ ok: boolean }> {
  return request(`/api/session/worldbooks/${id}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ worldbook: wb }),
  })
}

export function getIdentity(id: string): Promise<{ identity: Record<string, any> }> {
  return request(`/api/identities/${id}`)
}

export function getSessionIdentity(): Promise<{ identity: Record<string, any> }> {
  return request('/api/session/identity')
}

export function putSessionIdentity(identity: Record<string, any>): Promise<{ ok: boolean; identity: Record<string, any> }> {
  return request('/api/session/identity', {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ identity }),
  })
}
