import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  setApiKey, getConfig, updateConfig,
  getSystemInfo, shutdownComputer, cancelShutdown,
} from '@/lib/api'
import { useToast } from '@/store/toastStore'
import { EngineConfigForm, PromptsForm } from '@/components/config-editor'
import RenderPrefsEditor from '@/components/RenderPrefsEditor'
import EnvSetupCard from '@/components/EnvSetupCard'
import { useComposer } from '@/store/composer'
import { useNotices } from '@/store/noticeStore'
import { useShell, type SettingsSection } from '@/store/useShell'
import { useApiKey, useMissingApiKey } from '@/store/apiKeyStore'
import { cn } from '@/lib/utils'
import { AlertTriangle } from 'lucide-react'
import { LANGUAGES, useLang } from '@/i18n'
import { t } from '@/i18n'

export default function SettingsView() {
  const toast = useToast()
  const lang = useLang((s) => s.lang)
  const setLang = useLang((s) => s.setLang)
  const composer = useComposer()
  const notices = useNotices()
  const defaultPrecise = useComposer((s) => s.defaultPrecise)
  const section = useShell((s) => s.settingsSection)
  const setSection = useShell((s) => s.setSettingsSection)
  const keySet = useApiKey((s) => s.keySet)
  const mock = useApiKey((s) => s.mock)
  const keySource = useApiKey((s) => s.source)
  const envFile = useApiKey((s) => s.envFile)
  const missingKey = useMissingApiKey()
  const [key, setKey] = useState('')
  const [cfgText, setCfgText] = useState('')
  const [ip, setIp] = useState('')
  const [confirmOn, setConfirmOn] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // 进入设置页时刷新一次 Key 状态（例如用户直接在 server/.env 里改过）。
    void useApiKey.getState().refresh()
    getConfig().then((r) => setCfgText(JSON.stringify(r.config, null, 2)))
    getSystemInfo().then((r) => setIp(r.ip)).catch(() => setIp(''))
  }, [])

  const copyIp = async () => {
    if (!ip) return
    try {
      await navigator.clipboard.writeText(ip)
      toast.push(t('已复制 IP'), '', 'success')
    } catch {
      toast.push(t('复制失败'), `${t('请手动复制：')}${ip}`, 'error')
    }
  }

  const doShutdown = async () => {
    setBusy(true)
    try {
      await shutdownComputer()
      toast.push(t('已发送关机'), t('电脑将在 30 秒内关闭，可点「取消关机倒计时」'), 'success')
      setConfirmOn(false)
    } catch (e) {
      toast.push(t('关机失败'), String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const doCancel = async () => {
    try {
      await cancelShutdown()
      toast.push(t('已取消关机'), '', 'success')
    } catch (e) {
      toast.push(t('取消失败'), String(e), 'error')
    }
  }

  const saveKey = async () => {
    try {
      await setApiKey(key.trim())
      useApiKey.getState().markSet(true)
      toast.push(t('API Key 已保存'), '', 'success')
      setKey('')
    } catch (e) { toast.push(t('保存失败'), String(e), 'error') }
  }
  const saveCfg = async () => {
    try {
      await updateConfig(JSON.parse(cfgText))
      toast.push(t('配置已保存'), t('部分更改需重启服务生效'), 'success')
    } catch (e) { toast.push(t('保存失败（JSON 格式错误？）'), String(e), 'error') }
  }

  const SECTIONS: [SettingsSection, string][] = [
    ['engine', t('引擎参数')],
    ['prompts', t('提示词')],
    ['env', t('运行环境')],
    ['personal', t('个性化')],
    ['connection', t('连接 / 高级')],
  ]

  return (
    <div className="mx-auto h-full max-w-4xl space-y-5 overflow-y-auto p-5">
      <div className="sticky top-0 z-10 -mx-2 grid w-full max-w-2xl grid-cols-5 gap-1 rounded-xl bg-background/90 px-2 py-2 backdrop-blur">
        {SECTIONS.map(([k, l]) => (
          <Button
            key={k}
            variant={section === k ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'px-1 text-[13px]',
              k === 'connection' && missingKey && section !== k && 'border-amber-500/60 text-amber-700 dark:text-amber-200',
            )}
            onClick={() => setSection(k)}
          >
            {l}
            {k === 'connection' && missingKey && (
              <span className="ml-1 rounded-full bg-amber-500/20 px-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-300">!</span>
            )}
          </Button>
        ))}
      </div>

      {section === 'engine' && <EngineConfigForm />}
      {section === 'prompts' && <PromptsForm />}
      {section === 'env' && <EnvSetupCard />}

      {section === 'personal' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="mb-2 flex items-center gap-2 text-base font-semibold text-violet-700 dark:text-violet-200">
              {t('🌐 语言')}
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              {t('界面语言。切换后立即生效，选择会保存在浏览器里。角色卡、世界书等数据文件不会被翻译。')}
            </p>
            <div className="flex gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
              {LANGUAGES.map((l) => (
                <Button
                  key={l.value}
                  size="sm"
                  variant={lang === l.value ? 'default' : 'ghost'}
                  className="flex-1"
                  onClick={() => setLang(l.value)}
                >
                  {l.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 text-base font-semibold text-violet-700 dark:text-violet-200">
            {t('🎨 渲染样式')}
          </div>
          <RenderPrefsEditor />
          <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-4 py-3">
            <label className="text-sm">{t('默认开启精确模式')}</label>
            <Switch checked={defaultPrecise} onCheckedChange={(v) => composer.setDefaultPrecise(v)} />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/40 px-4 py-3">
            <div className="min-w-0 pr-3">
              <div className="text-sm">{t('后台通知')}</div>
              <div className="text-xs text-muted-foreground">{t('记忆总结 / 世界更新 / 角色更新 / 记忆遗忘的右上角提示')}</div>
            </div>
            <Switch checked={notices.showNotices} onCheckedChange={(v) => notices.setShowNotices(v)} />
          </div>

          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="mb-2 flex items-center gap-2 text-base font-semibold text-violet-700 dark:text-violet-200">
              {t('📱 手机远程')}
            </div>
            <div className="mb-3 rounded-lg bg-muted/40 px-3 py-2">
              <div className="text-xs text-muted-foreground">{t('服务端局域网 IP')}</div>
              <div className="flex items-center gap-2 text-lg font-bold text-violet-700 dark:text-violet-200">
                <code className="min-w-0 break-all">{ip || t('获取中…')}</code>
                {ip && (
                  <Button size="sm" variant="ghost" className="shrink-0 px-2" onClick={copyIp} title={t("复制 IP")}>📋</Button>
                )}
              </div>
              {ip && (
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {t('手机连同一 Wi-Fi，浏览器打开')} <code className="text-violet-700 dark:text-violet-300">http://{ip}:8000</code>
                </p>
              )}
            </div>

            {/* 关机：仅手机端显示 */}
            <div className="md:hidden">
              {!confirmOn ? (
                <Button variant="destructive" className="w-full gap-2" onClick={() => setConfirmOn(true)}>
                  {t('⏻ 关闭电脑（手机端使用）')}
                </Button>
              ) : (
                <div className="space-y-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
                  <p className="text-sm text-red-600 dark:text-red-300">{t('确定要关闭这台电脑吗？30 秒倒计时内可取消。')}</p>
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1" variant="destructive" onClick={doShutdown} disabled={busy}>
                      {busy ? t('发送中…') : t('确认关机')}
                    </Button>
                    <Button size="sm" className="flex-1" variant="ghost" onClick={() => setConfirmOn(false)}>{t('取消')}</Button>
                  </div>
                  <Button size="sm" variant="outline" className="w-full" onClick={doCancel}>
                    {t('取消关机倒计时')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {section === 'connection' && (
        <div className="space-y-4">
          {missingKey && (
            <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4">
              <div className="flex items-center gap-2 text-base font-semibold text-amber-700 dark:text-amber-200">
                <AlertTriangle className="size-5 shrink-0" />
                {t('尚未配置 DeepSeek API Key')}
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-amber-800/90 dark:text-amber-100/90">
                <li>{t('没有 Key 时：')}<b>{t('对话、世界更新、角色记忆总结都无法使用')}</b>{t('（界面可以正常浏览）。')}</li>
                <li>{t('Key 在 DeepSeek 开放平台申请：')}<code>platform.deepseek.com</code>{t('。')}</li>
                <li>{t('填写后只保存在本机')} <code>server/.env</code>{t('，不会进入版本库，且')}<b>{t('无需重启')}</b>{t('即可生效。')}</li>
              </ul>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-violet-700 dark:text-violet-200">🔑 DeepSeek API Key</span>
            <Badge variant={keySet ? 'default' : 'destructive'}>{keySet ? t('已设置') : t('！未设置')}</Badge>
            {mock && <Badge variant="outline">{t('离线 mock 模式')}</Badge>}
          </div>
          <div className="space-y-2">
            <Input type="password" className="h-10" placeholder={t("输入你的 API Key（保存在本地）")} value={key} onChange={(e) => setKey(e.target.value)} />
            <Button className="w-full" onClick={saveKey} disabled={!key.trim()}>{t('保存 Key')}</Button>
            <p className="text-sm text-muted-foreground">{t('Key 只保存在本机，不会进入版本库。设置后无需重启即可生效。')}</p>
            {keySet && (
              <p className="text-xs text-muted-foreground">
                {t('当前 Key 来源：')}
                {keySource === 'env' ? t('环境变量 DEEPSEEK_API_KEY')
                  : keySource === 'config.toml' ? t('server/config.toml 的 [llm] api_key')
                    : 'server/.env'}
                {keySource === '.env' && envFile ? `${t('（')}${envFile}${t('）')}` : ''}
              </p>
            )}
            {!keySet && envFile && (
              <p className="break-all text-xs text-muted-foreground">
                {t('也可以直接用编辑器写入')} <code>{envFile}</code>{t('：保存后立即生效（无需重启），')}
                {t('格式为')} <code>DEEPSEEK_API_KEY=sk-...</code>{t('。若系统里存在**空的**同名环境变量，它会被视为未配置。')}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <div className="mb-2 text-base font-semibold text-violet-700 dark:text-violet-200">{t('⚙️ 高级：原生配置（JSON）')}</div>
            <Textarea className="min-h-[280px] w-full resize-none overflow-y-auto font-mono text-sm" value={cfgText}
              onChange={(e) => setCfgText(e.target.value)} />
            <Button className="mt-2 w-full" onClick={saveCfg}>{t('保存配置')}</Button>
            <p className="mt-1 text-sm text-muted-foreground">{t('部分更改（如启动路径）需重启服务生效。')}</p>
          </div>
        </div>
      )}
    </div>
  )
}
