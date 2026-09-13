import { Globe, Save, WandSparkles, RefreshCcw, Crosshair, Brain } from 'lucide-react'
import type { ComponentType } from 'react'

export type FnId =
  | 'world_directive'
  | 'savepoint'
  | 'ai_write'
  | 'ai_rewrite'
  | 'precise'
  | 'show_thought'

export type FnKind = 'action' | 'toggle'

export interface FnDef {
  id: FnId
  label: string
  desc: string
  icon: ComponentType<{ className?: string }>
  kind: FnKind
}

export const FUNCTIONS: FnDef[] = [
  { id: 'ai_write', label: 'AI 帮写', desc: '让 AI 替你想一句接下来要说/做的事', icon: WandSparkles, kind: 'action' },
  { id: 'ai_rewrite', label: 'AI 重写', desc: '重写环境变化和角色行动', icon: RefreshCcw, kind: 'action' },
  { id: 'world_directive', label: '世界指令', desc: '设定未来一段时间的剧情走向', icon: Globe, kind: 'action' },
  { id: 'savepoint', label: '存档点', desc: '保存进度 / 回溯到某存档', icon: Save, kind: 'action' },
  { id: 'precise', label: '精确模式', desc: '说话 / 动作 / 思考 分开输入', icon: Crosshair, kind: 'toggle' },
  { id: 'show_thought', label: '显示角色思考', desc: '在对话中展示角色内心想法', icon: Brain, kind: 'toggle' },
]

export function fnById(id: FnId): FnDef | undefined {
  return FUNCTIONS.find((f) => f.id === id)
}
