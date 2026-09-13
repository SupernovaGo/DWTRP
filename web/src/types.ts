export interface Perception {
  time: string
  location: string
  weather: string
  details: (string | { id: string; text: string })[]
  scene_characters?: SceneCharacter[]
}

export interface SceneCharacter {
  name: string
  isolated?: boolean
}

export interface CharacterListItem {
  id: string
  name: string
  surname?: string
  is_core: boolean
  intro: string
  location: string
  mood: string
  doing: string
  avatar?: string
}

export interface CharacterDetail {
  id: string
  card: Record<string, unknown>
  state: Record<string, unknown>
  is_core: boolean
}

export interface MemoryStats {
  character_id: string
  events: number
  working_turns: number
  working_chars: number
}

export interface MemoryEvent {
  event_id: string
  source: string
  summary: string
  importance: number
  time_seq: number
  score?: number | null
}

export interface WorkingTurn {
  speaker: string
  text: string
}

/** 角色关系（新规范） */
export interface Relationship {
  target: string
  address?: string
  relation?: string
  detail?: string
  affection?: number | null
  directed?: boolean
}

export interface RelationEdge {
  from: string
  to: string
  address?: string
  relation?: string
  detail?: string
  affection?: number | null
  directed?: boolean
}

export interface RelationNode {
  id: string
  name: string
  is_core: boolean
  avatar?: string
}

export interface RelationGraph {
  nodes: RelationNode[]
  edges: RelationEdge[]
}

/** 世界书词条（设定） */
export interface WorldEntry {
  key: string
  name: string
  keywords: string[]
  importance: number
  info: string
}

/** 世界书地点树（最多三级） */
export interface WorldLocation {
  name: string
  description: string
  children: WorldLocation[]
}

export interface MemoryData {
  character_id: string
  max_events: number
  stats: MemoryStats
  working_memory: WorkingTurn[]
  events: MemoryEvent[]
}

export interface TimelineEvent {
  id: string
  time: string
  place: string
  description: string
  type?: string
}

export interface AppState {
  clock: string
  location: string
  weather: string
  perception: Perception
  world_summary: string
  world_meta?: { overview?: string; background?: string; tone?: string }
  timeline: TimelineEvent[]
  scene_history: string[]
  structured_history?: Record<string, unknown>[]
  scene_start?: number
  show_thought: boolean
  story_mode?: boolean
  manual_time_advance?: boolean
  manual_update?: boolean
  background_update_active?: boolean
  background_update_status?: string
  pending_updates?: Record<string, unknown>[]
  locations?: WorldLocation[]
  user_identity?: Record<string, unknown> & { name?: string; role?: string }
  characters: CharacterListItem[]
}

export interface SequenceSegment {
  type: 'action' | 'speech'
  text: string
}

export interface PlayerSegment {
  type: 'speech' | 'action' | 'think'
  text: string
}

interface LogBase {
  id: string
  ts?: number
  ptime?: string
}

export type LogEntry = LogBase & (
  | { kind: 'player'; name: string; text: string; segments?: PlayerSegment[]; sceneIndex?: number }
  | { kind: 'story'; text: string; directive?: string; sceneIndex?: number }
  | { kind: 'scene'; name: string; text: string; sceneIndex?: number }
  | { kind: 'character'; name: string; character?: string; thought?: string; sequence: SequenceSegment[]; silent: boolean; sceneIndex?: number }
  | { kind: 'environment'; perception: Partial<Perception>; changed: string[] }
  | { kind: 'hint'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'world_update'; changes: TimelineEvent[]; rendered: string }
  | { kind: 'character_update'; updated: string[] }
  | { kind: 'memory_summary'; character: string; detail: string }
  | { kind: 'forget'; character: string; event_count: number }
)

export interface SSEEvent {
  type: string
  [key: string]: unknown
}
