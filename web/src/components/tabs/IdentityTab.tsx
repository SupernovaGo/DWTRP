import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { getSessionIdentity, putSessionIdentity } from '@/lib/api'
import { useToast } from '@/store/toastStore'
import { t } from '@/i18n'

export default function IdentityTab() {
  const toast = useToast()
  const [identity, setIdentity] = useState<Record<string, any>>({})

  useEffect(() => {
    getSessionIdentity().then((r) => setIdentity(r.identity))
  }, [])

  const save = async () => {
    try {
      await putSessionIdentity(identity)
      toast.push(t('身份已保存（仅影响当前会话）'), '', 'success')
    } catch (e) {
      toast.push(t('保存失败'), String(e), 'error')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden p-4">
      <Card className="flex min-h-0 flex-1 flex-col border-border/60 bg-background/40">
        <CardHeader className="shrink-0 pb-2">
          <CardTitle className="text-base font-semibold text-violet-700 dark:text-violet-200">{t('🧑 当前会话身份')}</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <label className="block text-sm"><span className="text-muted-foreground">{t('名称')}</span>
            <Input className="mt-1.5" value={identity.name ?? ''} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} />
          </label>
          <label className="block text-sm"><span className="text-muted-foreground">{t('身份 / 角色')}</span>
            <Input className="mt-1.5" value={identity.role ?? ''} onChange={(e) => setIdentity({ ...identity, role: e.target.value })} />
          </label>
          <label className="block text-sm"><span className="text-muted-foreground">{t('描述')}</span>
            <Textarea className="mt-1.5 min-h-28" rows={5} value={identity.description ?? ''} onChange={(e) => setIdentity({ ...identity, description: e.target.value })} />
          </label>
        </CardContent>
        <div className="shrink-0 space-y-2 border-t border-border/60 p-3">
          <Button className="w-full" onClick={save}>{t('保存')}</Button>
          <p className="text-sm text-muted-foreground">{t('改动只影响当前会话，不影响资源库里的身份卡模板。')}</p>
        </div>
      </Card>
    </div>
  )
}
