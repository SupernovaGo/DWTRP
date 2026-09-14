import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getConfig, getSessionConfig, updateSessionConfig, getPrompts, updatePrompts } from '@/lib/api'
import { useApp } from '@/store/appStore'
import { useToast } from '@/store/toastStore'
import {
  ChoiceField,
  NumberField,
  TextField,
} from '@/components/config-fields'
import UpdateConfigCard from '@/components/UpdateConfigCard'
import { t } from '@/i18n'

type AgentCfg = { model: string; temperature: number; max_tokens: number; thinking: boolean; [k: string]: unknown }

function mergeDeep(base: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = mergeDeep(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

export default function ConfigTab() {
  const app = useApp()
  const toast = useToast()
  const [section, setSection] = useState<'engine' | 'prompts'>('engine')
  const [cfg, setCfg] = useState<Record<string, any>>({})
  const [prompts, setPrompts] = useState<Record<string, string> | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    Promise.all([getSessionConfig(), getConfig()])
      .then(([sess, glob]) => setCfg(mergeDeep(glob.config ?? {}, sess.config ?? {})))
      .catch((e) => toast.push(t('加载配置失败'), String(e), 'error'))
    getPrompts().then((r) => setPrompts(r.prompts)).catch((e) => toast.push(t('加载提示词失败'), String(e), 'error'))
  }, [])

  const world = cfg.world ?? {}
  const memory = cfg.memory ?? {}
  const llm = cfg.llm ?? {}
  const update = cfg.update ?? {}
  const agents = Object.entries(llm)
    .filter(([k, v]) => typeof v === 'object' && v !== null && !['api_base', 'api_key_env'].includes(k))
    .map(([k, v]) => [k, v as AgentCfg] as const)
  const AGENT_LABELS: Record<string, string> = {
    player: t('玩家 Agent'),
    frontend: t('角色前台'),
    environment: t('可观测环境'),
    character_memory: t('角色记忆总结'),
    character_plan: t('角色规划'),
    world_update: t('世界更新'),
    memory_summary: t('记忆总结器'),
    memory_planner: t('记忆检索规划'),
    session_init: t('开场初始化'),
  }

  const save = async () => {
    setSaving(true)
    try {
      await updateSessionConfig({ world, memory, llm, update })
      const r = await getSessionConfig()
      const g = await getConfig()
      setCfg(mergeDeep(g.config ?? {}, r.config ?? {}))
      toast.push(t('已保存为会话配置'), t('仅影响当前会话，不影响全局'), 'success')
    } catch (e) {
      toast.push(t('保存失败'), String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const resetToGlobal = async () => {
    try {
      await updateSessionConfig({})
      const g = await getConfig()
      setCfg(mergeDeep(g.config ?? {}, {}))
      toast.push(t('已恢复为全局设置'), t('当前会话不再覆盖'), 'success')
    } catch (e) {
      toast.push(t('恢复失败'), String(e), 'error')
    }
  }

  const savePrompts = async () => {
    if (!prompts) return
    try {
      const r = await updatePrompts(prompts)
      setPrompts(r.prompts)
      toast.push(t('提示词已保存'), '', 'success')
    } catch (e) {
      toast.push(t('保存失败'), String(e), 'error')
    }
  }

  const patchAgent = (name: string, patch: Partial<AgentCfg>) => {
    setCfg((c) => ({ ...c, llm: { ...c.llm, [name]: { ...(c.llm[name] as AgentCfg), ...patch } } }))
  }

  const runManual = async (target: 'world' | 'character') => {
    await useApp.getState().manualUpdate(target)
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="grid shrink-0 grid-cols-2 gap-1">
        <Button variant={section === 'engine' ? 'default' : 'outline'} size="sm" onClick={() => setSection('engine')}>
          {t('引擎参数')}
        </Button>
        <Button variant={section === 'prompts' ? 'default' : 'outline'} size="sm" onClick={() => setSection('prompts')}>
          {t('提示词')}
        </Button>
      </div>

      {section === 'engine' && (
        <div className="space-y-3">
          <Card className="border-border/60 bg-background/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">{t('🌍 世界 & 记忆')}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <NumberField label={t("每次默认推进时长(分钟)")} value={world.default_advance_minutes ?? 15} onChange={(v) => setCfg((c) => ({ ...c, world: { ...c.world, default_advance_minutes: v } }))} />
              <NumberField label={t("长期记忆上限条数")} value={memory.max_events ?? 300} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, max_events: v } }))} />
              <NumberField label={t("检索事件数")} value={memory.top_events ?? 4} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, top_events: v } }))} />
              <NumberField label={t("记忆总结比例(0.5=前一半)")} value={memory.working_summarize_ratio ?? 0.5} min={0.05} max={0.95} step={0.05} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, working_summarize_ratio: v } }))} />

              <NumberField label={t("检索到的长期记忆上限(字符)")} value={memory.max_context_chars ?? 5000} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, max_context_chars: v } }))} />
              <NumberField label={t("近期记忆上限(字)")} value={memory.working_memory_limit ?? 8000} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, working_memory_limit: v } }))} />
              <NumberField label={t("检索·向量权重")} value={memory.retrieval_embedding_weight ?? 0.6} min={0} max={1} step={0.05} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, retrieval_embedding_weight: v } }))} />
              <NumberField label={t("检索·关键词权重")} value={memory.retrieval_bm25_weight ?? 0.4} min={0} max={1} step={0.05} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, retrieval_bm25_weight: v } }))} />
              <NumberField label={t("检索·相关性权重")} value={memory.relevance_weight ?? 0.6} min={0} max={1} step={0.05} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, relevance_weight: v } }))} />
              <NumberField label={t("检索·重要度权重")} value={memory.importance_weight ?? 0.2} min={0} max={1} step={0.05} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, importance_weight: v } }))} />
              <NumberField label={t("检索·时效权重")} value={memory.recency_weight ?? 0.2} min={0} max={1} step={0.05} onChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, recency_weight: v } }))} />
              <NumberField label={t("世界书词条插入深度(回合)")} value={world.world_entry_depth ?? 2} min={1} max={10} onChange={(v) => setCfg((c) => ({ ...c, world: { ...c.world, world_entry_depth: v } }))} />
              <NumberField label={t("世界书词条最大数量")} value={world.world_entry_max ?? 4} min={1} max={20} onChange={(v) => setCfg((c) => ({ ...c, world: { ...c.world, world_entry_max: v } }))} />
              <ChoiceField
                label={t("角色上下文信息详细度")}
                value={world.player_character_detail ?? 'full'}
                onChange={(v) => setCfg((c) => ({ ...c, world: { ...c.world, player_character_detail: v } }))}
                options={[
                  { value: 'full', label: t('全量') },
                  { value: 'brief', label: t('精简') },
                ]}
              />
              <label className="col-span-2 flex items-center justify-between gap-2 text-sm">
                <span>{t('仅核心角色生成长期记忆与规划')}</span>
                <Switch checked={Boolean(world.core_only_update)} onCheckedChange={(v) => setCfg((c) => ({ ...c, world: { ...c.world, core_only_update: v } }))} />
              </label>
              <label className="col-span-2 flex items-center justify-between gap-2 text-sm">
                <span>{t('允许记忆多轮检索（输出时间将变长）')}</span>
                <Switch checked={Boolean(memory.agentic_retrieval)} onCheckedChange={(v) => setCfg((c) => ({ ...c, memory: { ...c.memory, agentic_retrieval: v } }))} />
              </label>
            </CardContent>
          </Card>

          <UpdateConfigCard config={cfg} onChange={setCfg} />
          <div className="flex items-center gap-2">
            <Button variant="outline" className="flex-1" onClick={() => runManual('world')}>{t('立即更新世界')}</Button>
            <Button variant="outline" className="flex-1" onClick={() => runManual('character')}>{t('立即更新角色')}</Button>
          </div>

          <Card className="border-border/60 bg-background/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">{t('🤖 各 Agent 模型')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {agents.map(([name, agent]) => (
                <div key={name} className="rounded-lg border border-border/60 p-2">
                  <div className="mb-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
                    {AGENT_LABELS[name] ?? name}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <TextField label={t("模型")} value={agent.model} onChange={(v) => patchAgent(name, { model: v })} />
                    <NumberField label={t("温度")} value={agent.temperature} onChange={(v) => patchAgent(name, { temperature: v })} />
                    <NumberField label={t("最大token")} value={agent.max_tokens} onChange={(v) => patchAgent(name, { max_tokens: v })} />
                    <ChoiceField
                      label={t("思考级别")}
                      value={(agent.reasoning_effort as string) ?? 'low'}
                      onChange={(v) => patchAgent(name, { reasoning_effort: v })}
                      options={[
                        { value: 'low', label: 'low' },
                        { value: 'medium', label: 'medium' },
                        { value: 'high', label: 'high' },
                      ]}
                    />
                    <label className="flex items-center justify-between gap-2 text-sm">
                      <span>{t('思考模式（开启时默认low）')}</span>
                      <Switch checked={Boolean(agent.thinking)} onCheckedChange={(v) => patchAgent(name, { thinking: v })} />
                    </label>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-2">
            <Button className="flex-1" onClick={save} disabled={saving}>
              {saving ? t('保存中…') : t('保存为会话配置')}
            </Button>
            <Button variant="outline" onClick={resetToGlobal} disabled={saving}>
              {t('恢复全局设置')}
            </Button>
            <Button variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setConfirmReset(true)}>
              {t('重置会话')}
            </Button>
          </div>
        </div>
      )}

      {section === 'prompts' && (
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
          <Button className="w-full" onClick={savePrompts}>
            {t('保存提示词')}
          </Button>
        </div>
      )}

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('确认重置当前会话？')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('这会清空当前会话的时间线、场景历史与运行时记忆，回到干净起点。角色卡与世界书不受影响。')}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              {t('取消')}
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await app.reset()
                setConfirmReset(false)
                toast.push(t('已重置会话'), '', 'success')
              }}
            >
              {t('重置')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
