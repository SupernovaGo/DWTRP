import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import WorldTab from '@/components/tabs/WorldTab'
import CharactersTab from '@/components/tabs/CharactersTab'
import ConfigTab from '@/components/tabs/ConfigTab'
import IdentityTab from '@/components/tabs/IdentityTab'
import FunctionsTab from '@/components/tabs/FunctionsTab'

export default function WorldPanel({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-border/60 px-4 py-2.5">
        <h2 className="text-base font-semibold">🎛️ 世界面板</h2>
        {onClose && (
          <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={onClose} title="收起">
            <X className="size-4" />
          </Button>
        )}
      </div>
      <Tabs defaultValue="world" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-3 mt-2.5 grid grid-cols-5 gap-1.5">
          <TabsTrigger value="world">世界</TabsTrigger>
          <TabsTrigger value="characters">角色</TabsTrigger>
          <TabsTrigger value="identity">身份</TabsTrigger>
          <TabsTrigger value="config">配置</TabsTrigger>
          <TabsTrigger value="functions">功能</TabsTrigger>
        </TabsList>
        <TabsContent value="world" className="min-h-0 flex-1">
          <div className="h-full overflow-hidden"><WorldTab /></div>
        </TabsContent>
        <TabsContent value="characters" className="min-h-0 flex-1">
          <div className="h-full overflow-hidden"><CharactersTab /></div>
        </TabsContent>
        <TabsContent value="identity" className="min-h-0 flex-1">
          <div className="h-full overflow-hidden"><IdentityTab /></div>
        </TabsContent>
        <TabsContent value="config" className="min-h-0 flex-1">
          <div className="h-full overflow-hidden"><ConfigTab /></div>
        </TabsContent>
        <TabsContent value="functions" className="min-h-0 flex-1">
          <div className="h-full overflow-hidden"><FunctionsTab /></div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
