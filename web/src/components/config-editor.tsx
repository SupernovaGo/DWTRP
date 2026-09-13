import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { getConfig, updateConfig, getPrompts, updatePrompts } from '@/lib/api'
import { useToast } from '@/store/toastStore'
import {
  ChoiceField,
  NumberField,
  TextField,
} from '@/components/config-fields'
import UpdateConfigCard from '@/components/UpdateConfigCard'

type AgentCfg = {
  model: string
  temperature: number
  max_tokens: number
  thinking: boolean
  [k: string]: unknown
}

export function EngineConfigForm() {
  const toast = useToast()
  const [cfg, setCfg] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getConfig()
      .then((r) => setCfg(r.config))
      .catch((e) => toast.push('加载配置失败', String(e), 'error'))
  }, [])

  const world = cfg.world ?? {}
  const memory = cfg.memory ?? {}
  const llm = cfg.llm ?? {}
  const snapshot = cfg.snapshot ?? {}
  const update = cfg.update ?? {}
  const logs = cfg.logs ?? {}
  const agents = Object.entries(llm)
    .filter(([k, v]) => typeof v === 'object' && v !== null && !['api_base', 'api_key_env'].includes(k))
    .map(([k, v]) => [k, v as AgentCfg] as const)

  const patchWorld = (v: Record<string, unknown>) => setCfg((c) => ({ ...c, world: { ...c.world, ...v } }))
  const patchMemory = (v: Record<string, unknown>) => setCfg((c) => ({ ...c, memory: { ...c.memory, ...v } }))
  const patchAgent = (name: string, patch: Partial<AgentCfg>) =>
    setCfg((c) => ({ ...c, llm: { ...c.llm, [name]: { ...(c.llm[name] as AgentCfg), ...patch } } }))

  const save = async () => {
    setSaving(true)
    try {
      await updateConfig({ world, memory, llm, snapshot, update, logs })
      const r = await getConfig()
      setCfg(r.config)
      toast.push('配置已保存', '将作为新建会话的默认设置', 'success')
    } catch (e) {
      toast.push('保存失败', String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card className="border-border/60 bg-background/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">🌍 世界 & 记忆</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <NumberField label="每次默认推进时长(分钟)" value={world.default_advance_minutes ?? 15} onChange={(v) => patchWorld({ default_advance_minutes: v })} />
          <NumberField label="近期事件容量（回合）" value={world.scene_history_limit ?? 24} min={1} max={200} onChange={(v) => patchWorld({ scene_history_limit: v })} />
          <NumberField label="长期记忆上限条数" value={memory.max_events ?? 300} onChange={(v) => patchMemory({ max_events: v })} />
          <NumberField label="检索事件数" value={memory.top_events ?? 4} onChange={(v) => patchMemory({ top_events: v })} />
          <NumberField label="记忆总结比例(0.5=前一半)" value={memory.working_summarize_ratio ?? 0.5} min={0.05} max={0.95} step={0.05} onChange={(v) => patchMemory({ working_summarize_ratio: v })} />

          <NumberField label="检索到的长期记忆上限(字符)" value={memory.max_context_chars ?? 5000} onChange={(v) => patchMemory({ max_context_chars: v })} />
          <NumberField label="近期记忆上限(字)" value={memory.working_memory_limit ?? 8000} onChange={(v) => patchMemory({ working_memory_limit: v })} />
          <NumberField label="检索·向量权重" value={memory.retrieval_embedding_weight ?? 0.6} min={0} max={1} step={0.05} onChange={(v) => patchMemory({ retrieval_embedding_weight: v })} />
          <NumberField label="检索·关键词权重" value={memory.retrieval_bm25_weight ?? 0.4} min={0} max={1} step={0.05} onChange={(v) => patchMemory({ retrieval_bm25_weight: v })} />
          <NumberField label="检索·相关性权重" value={memory.relevance_weight ?? 0.6} min={0} max={1} step={0.05} onChange={(v) => patchMemory({ relevance_weight: v })} />
          <NumberField label="检索·重要度权重" value={memory.importance_weight ?? 0.2} min={0} max={1} step={0.05} onChange={(v) => patchMemory({ importance_weight: v })} />
          <NumberField label="检索·时效权重" value={memory.recency_weight ?? 0.2} min={0} max={1} step={0.05} onChange={(v) => patchMemory({ recency_weight: v })} />
          <NumberField label="世界书词条插入深度(回合)" value={world.world_entry_depth ?? 2} min={1} max={10} onChange={(v) => patchWorld({ world_entry_depth: v })} />
          <NumberField label="世界书词条最大数量" value={world.world_entry_max ?? 4} min={1} max={20} onChange={(v) => patchWorld({ world_entry_max: v })} />
          <label className="col-span-2 flex items-center justify-between gap-2 text-sm">
            <span>允许记忆多轮检索（输出时间将变长）</span>
            <Switch checked={Boolean(memory.agentic_retrieval)} onCheckedChange={(v) => patchMemory({ agentic_retrieval: v })} />
          </label>
          <NumberField
            label="日志保留天数（默认 3；0 = 永久保留）"
            value={logs.retention_days ?? 3}
            min={0}
            max={3650}
            onChange={(v) => setCfg((c) => ({ ...c, logs: { ...c.logs, retention_days: v } }))}
          />
        </CardContent>
      </Card>

      <UpdateConfigCard config={cfg} onChange={setCfg} />

      <Card className="border-border/60 bg-background/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">🤖 各 Agent 模型</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {agents.map(([name, agent]) => (
            <div key={name} className="rounded-lg border border-border/60 p-3">
              <div className="mb-2 text-sm font-semibold text-violet-700 dark:text-violet-300">{name}</div>
              <div className="grid grid-cols-2 gap-3">
                <TextField label="模型" value={agent.model} onChange={(v) => patchAgent(name, { model: v })} />
                <NumberField label="温度" value={agent.temperature} onChange={(v) => patchAgent(name, { temperature: v })} />
                <NumberField label="最大token" value={agent.max_tokens} onChange={(v) => patchAgent(name, { max_tokens: v })} />
                <ChoiceField
                  label="思考级别"
                  value={(agent.reasoning_effort as string) ?? 'low'}
                  onChange={(v) => patchAgent(name, { reasoning_effort: v })}
                  options={[
                    { value: 'low', label: 'low' },
                    { value: 'medium', label: 'medium' },
                    { value: 'high', label: 'high' },
                  ]}
                />
                <label className="flex items-center justify-between gap-2 text-sm">
                  <span>思考模式（默认low）</span>
                  <Switch checked={Boolean(agent.thinking)} onCheckedChange={(v) => patchAgent(name, { thinking: v })} />
                </label>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="border-border/60 bg-background/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">💾 存档点（回溯）</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <NumberField
            label="自动存档间隔（每 N 轮）· 0 关闭"
            value={snapshot.interval ?? 0}
            min={0}
            max={999}
            onChange={(v) => setCfg((c) => ({ ...c, snapshot: { ...c.snapshot, interval: v } }))}
          />
          <NumberField
            label="自动存档保留数"
            value={snapshot.max ?? 20}
            min={1}
            max={200}
            onChange={(v) => setCfg((c) => ({ ...c, snapshot: { ...c.snapshot, max: v } }))}
          />
          <NumberField
            label="回合回退上限（保留最近 N 回合 · 0 关闭）"
            value={snapshot.rewind_max_turns ?? 10}
            min={0}
            max={100}
            onChange={(v) => setCfg((c) => ({ ...c, snapshot: { ...c.snapshot, rewind_max_turns: v } }))}
          />
        </CardContent>
      </Card>

      <Button className="sticky bottom-0 z-10 w-full border border-border/60 shadow-lg" onClick={save} disabled={saving}>
        {saving ? '保存中…' : '保存默认设置'}
      </Button>
    </div>
  )
}

export function PromptsForm() {
  const toast = useToast()
  const [prompts, setPrompts] = useState<Record<string, string> | null>(null)

  useEffect(() => {
    getPrompts()
      .then((r) => setPrompts(r.prompts))
      .catch((e) => toast.push('加载提示词失败', String(e), 'error'))
  }, [])

  const save = async () => {
    if (!prompts) return
    try {
      const r = await updatePrompts(prompts)
      setPrompts(r.prompts)
      toast.push('提示词已保存', '', 'success')
    } catch (e) {
      toast.push('保存失败', String(e), 'error')
    }
  }

  return (
    <div className="space-y-3">
      {prompts &&
        Object.entries(prompts).map(([key, text]) => (
          <Card key={key} className="border-border/60 bg-background/40">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-semibold text-violet-700 dark:text-violet-200">{key}</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea className="min-h-[160px] font-mono text-sm" value={text} onChange={(e) => setPrompts((p) => (p ? { ...p, [key]: e.target.value } : p))} />
            </CardContent>
          </Card>
        ))}
      <Button className="sticky bottom-0 z-10 w-full border border-border/60 shadow-lg" onClick={save}>
        保存提示词
      </Button>
    </div>
  )
}
