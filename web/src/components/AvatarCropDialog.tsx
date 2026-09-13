import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/store/toastStore'
import { avatarUrl } from '@/lib/format'

interface Props {
  open: boolean
  onClose: () => void
  onApply: (base64: string) => void
  defaultValue?: string
}

/**
 * 角色头像导入：从本地选择图片，并框选方形区域作为头像。
 * 结果以 base64 dataURL 返回，由调用方写入角色卡「头像」字段。
 */
export default function AvatarCropDialog({ open, onClose, onApply, defaultValue }: Props) {
  const toast = useToast()
  const imgRef = useRef<HTMLImageElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [src, setSrc] = useState('')
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [render, setRender] = useState({ w: 0, h: 0 })
  const [sel, setSel] = useState({ x: 0, y: 0, size: 120 })
  const dragStart = useRef({ px: 0, py: 0, sx: 0, sy: 0, sz: 0 })
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setSrc(avatarUrl(defaultValue) || '')
    setNatural({ w: 0, h: 0 })
    setRender({ w: 0, h: 0 })
    setSel({ x: 0, y: 0, size: 120 })
  }, [open, defaultValue])

  const onImageLoad = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    const rw = img.getBoundingClientRect().width
    const rh = img.getBoundingClientRect().height
    setNatural({ w: nw, h: nh })
    setRender({ w: rw, h: rh })
    const size = Math.max(60, Math.min(rw, rh) * 0.6)
    setSel({ x: (rw - size) / 2, y: (rh - size) / 2, size })
  }, [])

  const clampSel = (rx: number, ry: number, rz: number) => {
    const { w, h } = render
    if (w <= 0 || h <= 0) return { x: 0, y: 0, size: 0 }
    const size = Math.max(40, Math.min(rz, w, h))
    const x = Math.max(0, Math.min(rx, w - size))
    const y = Math.max(0, Math.min(ry, h - size))
    return { x, y, size }
  }

  const onPointerDown = (e: React.PointerEvent, kind: 'move' | 'resize') => {
    e.preventDefault()
    dragStart.current = { px: e.clientX, py: e.clientY, sx: sel.x, sy: sel.y, sz: sel.size }
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - dragStart.current.px
      const dy = ev.clientY - dragStart.current.py
      if (kind === 'move') {
        setSel((s) => clampSel(dragStart.current.sx + dx, dragStart.current.sy + dy, s.size))
      } else {
        const sz = Math.max(dragStart.current.sz + dx, dragStart.current.sz + dy)
        setSel((s) => clampSel(s.x, s.y, sz))
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const apply = () => {
    const img = imgRef.current
    if (!img || !natural.w || !render.w || sel.size <= 0) {
      toast.push('无法裁剪', '请先选择一张图片', 'error')
      return
    }
    const scale = natural.w / render.w
    const cropX = sel.x * scale
    const cropY = sel.y * scale
    const cropSize = sel.size * scale
    const outSize = 256
    const canvas = document.createElement('canvas')
    canvas.width = outSize
    canvas.height = outSize
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, cropX, cropY, cropSize, cropSize, 0, 0, outSize, outSize)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    onApply(dataUrl)
    onClose()
  }

  const pick = () => fileRef.current?.click()

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.push('格式不支持', '请选择图片文件', 'error')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.push('图片过大', '请选择小于 8MB 的图片', 'error')
      return
    }
    const url = URL.createObjectURL(file)
    setSrc(url)
    setNatural({ w: 0, h: 0 })
  }

  const overlayStyle = {
    left: sel.x,
    top: sel.y,
    width: sel.size,
    height: sel.size,
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,520px)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>🖼️ 选择头像区域</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="rounded-lg border border-border/60 bg-muted/30 p-2">
            {src ? (
              <div ref={boxRef} className="relative inline-block leading-none" style={{ maxWidth: '100%' }}>
                <img
                  ref={imgRef}
                  src={src}
                  onLoad={onImageLoad}
                  alt="游戏头像裁剪"
                  className="block max-h-[340px] w-auto rounded-md object-contain"
                  draggable={false}
                />
                <div className="absolute stroke-fuchsia-500" style={{ ...overlayStyle, border: '2px solid #e879f9', boxShadow: '0 0 0 100vmax rgba(0,0,0,0.45)' }} onPointerDown={(e) => onPointerDown(e, 'move')}>
                  <div className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-fuchsia-500 bg-white" onPointerDown={(e) => onPointerDown(e, 'resize')} />
                </div>
              </div>
            ) : (
              <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">请选择一张图片</div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            拖动方块调整位置，拖动右下角圆点调整大小。头像会裁成正方形（256×256）。
          </p>
        </div>
        <DialogFooter>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
          <Button variant="ghost" onClick={pick}>选择图片</Button>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={apply} disabled={!src}>应用</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
