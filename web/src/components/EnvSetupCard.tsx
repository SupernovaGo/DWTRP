import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  cancelEnvTask,
  downloadEmbeddingModel,
  getConfig,
  getEnvStatus,
  getEnvTask,
  installEmbeddingDeps,
  updateConfig,
  type EnvStatus,
  type EnvTask,
} from '@/lib/api'
import { useToast } from '@/store/toastStore'
import { t } from '@/i18n'

/**
 * 「运行环境」设置卡片。
 *
 * 必需依赖只有 requirements.txt；torch / sentence-transformers 与嵌入模型是可选组件，
 * 未安装时记忆检索自动退回 BM25 关键词匹配。这里可以一键补装并查看进度。
 */
export default function EnvSetupCard() {
  const push = useToast((s) => s.push)
  const [status, setStatus] = useState<EnvStatus | null>(null)
  const [task, setTask] = useState<EnvTask | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [hfEndpoint, setHfEndpoint] = useState('')
  const [pipIndex, setPipIndex] = useState('')
  const [modelName, setModelName] = useState('')
  const pollRef = useRef<number | null>(null)

  const apply = useCallback((s: EnvStatus) => {
    setStatus(s)
    setTask(s.task)
    setEnabled(s.config.enabled)
    setHfEndpoint(s.config.hf_endpoint)
    setPipIndex(s.config.pip_index_url)
    setModelName(s.config.model_name)
  }, [])

  const load = useCallback(async (refresh = false) => {
    try {
      apply(await getEnvStatus(refresh))
    } catch (e) {
      push(t('读取运行环境失败'), String(e), 'error')
    }
  }, [apply, push])

  useEffect(() => { void load(false) }, [load])

  // 任务进行中：每 1.5 秒拉一次日志/状态。
  useEffect(() => {
    if (!task?.running) {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    if (pollRef.current) return
    pollRef.current = window.setInterval(async () => {
      try {
        const info = await getEnvTask()
        setTask(info)
        if (!info.running) {
          window.clearInterval(pollRef.current!)
          pollRef.current = null
          await load(true)
          push(
            info.state === 'done' ? t('可选组件已就绪') : t('任务已结束'),
            info.state === 'done' ? t('可在下方确认状态，重启服务后生效') : info.detail,
            info.state === 'done' ? 'success' : 'error',
          )
        }
      } catch { /* 轮询失败忽略，下一轮再试 */ }
    }, 1500)
    return () => {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [task?.running, load, push])

  const run = async (fn: () => Promise<{ task_id: string }>, label: string) => {
    setBusy(true)
    try {
      await fn()
      setTask(await getEnvTask())
      push(t('{label}已开始', { label }), t('进度显示在下方，可继续使用其它功能'), 'success')
    } catch (e) {
      push(t('{label}失败', { label }), String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const doCancel = async () => {
    try {
      const r = await cancelEnvTask()
      push(r.ok ? t('已取消') : t('取消失败'), r.detail ?? '', r.ok ? 'success' : 'error')
      setTask(await getEnvTask())
    } catch (e) {
      push(t('取消失败'), String(e), 'error')
    }
  }

  const saveEnvConfig = async () => {
    setSaving(true)
    try {
      const cfg = await getConfig()
      const embedding = { ...(cfg.config.embedding as Record<string, unknown> ?? {}), enabled, model_name: modelName }
      const env = { ...(cfg.config.env as Record<string, unknown> ?? {}), hf_endpoint: hfEndpoint, pip_index_url: pipIndex }
      await updateConfig({ embedding, env })
      await load(true)
      push(t('已保存'), t('向量检索开关与镜像地址立即生效'), 'success')
    } catch (e) {
      push(t('保存失败'), String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const emb = status?.embedding
  const depsReady = Boolean(emb?.deps_installed)
  const modelReady = Boolean(emb?.model_cached)
  const vectorActive = Boolean(enabled && depsReady && modelReady)
  const pyVersion = status?.python.major_minor ?? '3.11'
  const [pyMajor, pyMinor] = pyVersion.split('.').map((v) => Number(v) || 0)
  const pyOk = pyMajor > 3 || (pyMajor === 3 && pyMinor >= 11)

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/60 bg-background/40 p-4">
        <div className="mb-3 flex items-center gap-2 text-base font-semibold text-violet-700 dark:text-violet-200">
          {t('🧩 Python 环境')}
        </div>
        <div className="space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t('解释器')}</span>
            <code className="break-all">{status?.python.executable ?? t('读取中…')}</code>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t('版本')}</span>
            <Badge variant={pyOk ? 'default' : 'destructive'}>
              Python {status?.python.version ?? t('…')}
            </Badge>
            <Badge variant="outline">{status?.python.in_venv ? t('虚拟环境') : t('系统解释器')}</Badge>
            <Badge variant="secondary">{t('必需依赖')} {(status?.requirements ?? true) ? t('已就绪') : t('缺失')}</Badge>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 p-4">
        <div className="mb-2 flex items-center gap-2 text-base font-semibold text-violet-700 dark:text-violet-200">
          {t('🔎 记忆检索模式')}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={vectorActive ? 'default' : 'secondary'}>
            {vectorActive ? t('向量 + BM25') : t('仅 BM25 关键词')}
          </Badge>
          {!enabled && <span className="text-muted-foreground">{t('已在设置中关闭向量检索')}</span>}
          {enabled && !depsReady && <span className="text-muted-foreground">{t('未安装 torch / sentence-transformers')}</span>}
          {enabled && depsReady && !modelReady && <span className="text-muted-foreground">{t('嵌入模型尚未下载')}</span>}
          {emb?.loaded && <Badge variant="outline">{t('模型已加载')}</Badge>}
        </div>
        <div className="space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t('可选依赖')}</span>
            <Badge variant={depsReady ? 'default' : 'secondary'}>{depsReady ? t('已安装') : t('未安装')}</Badge>
            {depsReady && (
              <span className="text-xs text-muted-foreground">
                torch {emb?.torch_version || '?'} · sentence-transformers {emb?.sentence_transformers_version || '?'}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t('嵌入模型')}</span>
            <Badge variant={modelReady ? 'default' : 'secondary'}>{modelReady ? t('已缓存') : t('未下载')}</Badge>
            <span className="text-xs text-muted-foreground">{emb?.model_name}</span>
          </div>
          {modelReady && (
            <div className="break-all text-xs text-muted-foreground">{t('缓存路径：')}{emb?.model_path}</div>
          )}
          {depsReady === false && emb?.deps_error && (
            <div className="break-all text-xs text-muted-foreground">{t('原因：')}{emb.deps_error}</div>
          )}
          {emb?.last_error && (
            <div className="break-all text-xs text-amber-600 dark:text-amber-300">{t('最近一次加载失败：')}{emb.last_error}</div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || task?.running}
            onClick={() => run(() => installEmbeddingDeps(pipIndex), t('安装嵌入依赖'))}
          >
            {t('⬇ 安装嵌入依赖（torch 等）')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || task?.running || !depsReady}
            title={depsReady ? '' : t('请先安装嵌入依赖')}
            onClick={() => run(() => downloadEmbeddingModel(modelName, hfEndpoint), t('下载嵌入模型'))}
          >
            {t('⬇ 下载嵌入模型')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => load(true)}>{t('↻ 重新检测')}</Button>
          {task?.running && <Button size="sm" variant="destructive" onClick={doCancel}>{t('取消任务')}</Button>}
        </div>

        {task && task.state !== 'idle' && (
          <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <Badge variant={task.running ? 'secondary' : task.state === 'done' ? 'default' : 'destructive'}>
                {task.running ? t('进行中') : task.state === 'done' ? t('完成') : task.state === 'cancelled' ? t('已取消') : t('失败')}
              </Badge>
              <span className="text-muted-foreground">{task.detail}</span>
            </div>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-muted-foreground">
              {task.log.slice(-40).join('\n') || t('（等待输出…）')}
            </pre>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 p-4">
        <div className="mb-3 text-base font-semibold text-violet-700 dark:text-violet-200">{t('⚙️ 向量检索配置')}</div>
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t('启用向量检索')}
              <span className="ml-2 text-xs text-muted-foreground">{t('关闭后仅用 BM25 关键词匹配')}</span>
            </span>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>
          <div className="space-y-1">
            <div className="text-sm">{t('嵌入模型名')}</div>
            <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="BAAI/bge-base-zh-v1.5" />
          </div>
          <div className="space-y-1">
            <div className="text-sm">{t('HuggingFace 镜像（国内建议 https://hf-mirror.com）')}</div>
            <Input value={hfEndpoint} onChange={(e) => setHfEndpoint(e.target.value)} placeholder={t("留空 = 官方源")} />
          </div>
          <div className="space-y-1">
            <div className="text-sm">{t('pip 源（安装 torch 时使用，留空 = 默认源）')}</div>
            <Input value={pipIndex} onChange={(e) => setPipIndex(e.target.value)} placeholder="https://pypi.tuna.tsinghua.edu.cn/simple" />
          </div>
          <Button className="w-full" onClick={saveEnvConfig} disabled={saving || task?.running}>
            {saving ? t('保存中…') : t('保存向量检索设置')}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t('不安装可选依赖与模型也能正常对话与会话管理，此时长期记忆只按 BM25 关键词 + 重要度 + 时效性检索。')}
          </p>
        </div>
      </div>
    </div>
  )
}
