import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Share2 } from 'lucide-react'
import { getCharacterGraph } from '@/lib/api'
import type { RelationEdge, RelationGraph } from '@/types'
import { avatarUrl } from '@/lib/format'

interface Props {
  focusName: string
  onBack: () => void
  onFocus: (name: string) => void
}

const W = 560
const H = 460

function edgeColor(affection?: number | null) {
  if (affection == null || Number.isNaN(Number(affection))) return 'var(--muted-foreground)'
  const v = Number(affection)
  if (v >= 0.7) return '#e879f9'
  if (v >= 0.4) return '#a855f7'
  return '#7c3aed'
}

/** 点击节点后，在节点旁弹出该条关系的"详细说明"小框。 */
function DetailPopover({
  name,
  x,
  y,
  edge,
  onClose,
}: {
  name: string
  x: number
  y: number
  edge?: RelationEdge
  onClose: () => void
}) {
  const lines: string[] = []
  if (edge?.address) lines.push(`称呼：${edge.address}`)
  if (edge?.relation) lines.push(`关系：${edge.relation}`)
  if (edge?.affection != null && !Number.isNaN(Number(edge.affection))) {
    lines.push(`好感度：${Number(edge.affection).toFixed(2)}`)
  }
  if (edge?.directed) lines.push('单向：对方可能并不了解本角色')
  if (edge?.detail) lines.push(`详述：${edge.detail}`)
  if (!edge) lines.push('（这是本角色的视角）')
  const boxW = 220
  const boxX = Math.min(x - boxW / 2, W - boxW - 8)
  const boxY = Math.max(8, Math.min(y - 140, H - 170))
  return (
    <g>
      <rect x={boxX} y={boxY} width={boxW} height={150} rx="10"
        fill="var(--popover)" stroke="var(--border)" strokeWidth="1.2" />
      <foreignObject x={boxX + 10} y={boxY + 8} width={boxW - 20} height={134}>
        <div className="flex h-full flex-col gap-1 overflow-hidden text-xs" style={{ color: 'var(--popover-foreground)' }}>
          <div className="flex items-center justify-between font-semibold">
            <span>{name}</span>
            <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="leading-snug text-muted-foreground whitespace-pre-wrap break-words">{l}</div>
          ))}
        </div>
      </foreignObject>
    </g>
  )
}

export default function RelationsView({ focusName, onBack, onFocus }: Props) {
  const [graph, setGraph] = useState<RelationGraph | null>(null)
  const [error, setError] = useState('')
  const [sel, setSel] = useState<string | null>(null)

  useEffect(() => {
    getCharacterGraph().then(setGraph).catch((e) => setError(String(e)))
  }, [])

  const layout = useMemo(() => {
    if (!graph) return null
    const nodesById = new Map(graph.nodes.map((n) => [n.name, n]))
    const center = nodesById.get(focusName)
    if (!center) return null

    const neighbors = new Set<string>()
    const edges: RelationEdge[] = []
    for (const e of graph.edges) {
      if (e.from === focusName) {
        neighbors.add(e.to)
        edges.push(e)
      } else if (e.to === focusName) {
        neighbors.add(e.from)
        edges.push({ ...e, from: focusName, to: e.from, directed: true })
      }
    }
    for (const e of graph.edges) {
      if (neighbors.has(e.from) && neighbors.has(e.to)) edges.push(e)
    }

    const cx = W / 2
    const cy = H / 2
    const radius = Math.min(W, H) * 0.36
    const neiList = Array.from(neighbors)
    const positions = new Map<string, { x: number; y: number }>()
    positions.set(focusName, { x: cx, y: cy })
    neiList.forEach((name, i) => {
      const angle = (2 * Math.PI * i) / Math.max(neiList.length, 1) - Math.PI / 2
      positions.set(name, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
    })
    return { positions, edges, nodesById, neighbors }
  }, [graph, focusName])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <Share2 className="size-8" />
        <div>加载关系网失败：{error}</div>
        <Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="size-4" /> 返回</Button>
      </div>
    )
  }
  if (!layout) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载关系网…</div>
  }

  // 点击节点时，找出它与中心/目标之间的一条关系，用于 popover 展示详情
  const selEdgeInfo: RelationEdge | undefined =
    sel && layout ? layout.edges.find((e) => (e.from === sel || e.to === sel)) : undefined

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> 返回</Button>
        <h3 className="text-base font-semibold text-violet-700 dark:text-violet-200">🕸️ {focusName} 的关系网</h3>
        <span className="ml-auto text-[11px] text-muted-foreground">点击节点查看详细关系</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
          <defs>
            <filter id="nodeShadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.25" />
            </filter>
            {Array.from(layout.positions.keys()).map((name) => {
              const node = layout.nodesById.get(name)
              if (!avatarUrl(node?.avatar)) return null
              const r = name === focusName ? 28 : 20
              return <clipPath key={name} id={`clip-${name}`}><circle r={r} /></clipPath>
            })}
          </defs>
          {layout.edges.map((e, i) => {
            const p1 = layout.positions.get(e.from)
            const p2 = layout.positions.get(e.to)
            if (!p1 || !p2) return null
            const dx = p2.x - p1.x
            const dy = p2.y - p1.y
            const len = Math.hypot(dx, dy) || 1
            const ux = dx / len
            const uy = dy / len
            const startX = p1.x + ux * 26
            const startY = p1.y + uy * 26
            const endX = p2.x - ux * 26
            const endY = p2.y - uy * 26
            const midX = (startX + endX) / 2
            const midY = (startY + endY) / 2
            const color = edgeColor(e.affection)
            const label = e.relation || e.address || ''
            const lw = Math.max(44, label.length * 13 + 14)
            return (
              <g key={i}>
                <line x1={startX} y1={startY} x2={endX} y2={endY}
                  stroke={color} strokeWidth="2" strokeDasharray={e.directed ? '6 4' : 'none'} />
                {e.directed && (
                  <>
                    <line x1={endX} y1={endY} x2={endX - ux * 8 - uy * 5} y2={endY - uy * 8 + ux * 5} stroke={color} strokeWidth="2" />
                    <line x1={endX} y1={endY} x2={endX - ux * 8 + uy * 5} y2={endY - uy * 8 - ux * 5} stroke={color} strokeWidth="2" />
                  </>
                )}
                {label && (
                  <g>
                    <rect x={midX - lw / 2} y={midY - 11} width={lw} height="22" rx="11"
                      fill="var(--popover)" stroke="var(--border)" />
                    <text x={midX} y={midY + 4} textAnchor="middle" fontSize="11" fontWeight="600"
                      fill="var(--popover-foreground)">{label}</text>
                  </g>
                )}
              </g>
            )
          })}
          {Array.from(layout.positions.entries()).map(([name, pos]) => {
            const node = layout.nodesById.get(name)
            const isCenter = name === focusName
            const r = isCenter ? 28 : 20
            const avatarSrc = avatarUrl(node?.avatar)
            return (
              <g key={name} transform={`translate(${pos.x},${pos.y})`} className="cursor-pointer"
                onClick={() => (name === focusName ? onFocus(name) : setSel(name === sel ? null : name))}>
                {avatarSrc ? (
                  <>
                    <circle r={r} fill="#111827" opacity="0.4" />
                    <image href={avatarSrc} x={-r} y={-r} width={2 * r} height={2 * r}
                      preserveAspectRatio="xMidYMid slice" clipPath={`url(#clip-${name})`} />
                    <circle r={r} fill="none" stroke="var(--foreground)" strokeWidth="2" filter="url(#nodeShadow)" />
                    <title>{name}</title>
                  </>
                ) : (
                  <>
                    <circle r={r} fill={isCenter ? '#a855f7' : node?.is_core ? '#7c3aed' : 'var(--muted)'} stroke="var(--foreground)" strokeWidth="2" filter="url(#nodeShadow)" />
                    <text y="5" textAnchor="middle" fontSize={isCenter ? 18 : 13} fill="var(--foreground)" fontWeight="700">
                      {(name || '?').slice(0, 1)}
                    </text>
                    <text y={r + 14} textAnchor="middle" fontSize="12"
                      fill="var(--foreground)" fontWeight={isCenter ? 700 : 500}>{name}</text>
                  </>
                )}
              </g>
            )
          })}
          {sel && layout.positions.get(sel) && (
            <DetailPopover name={sel} x={layout.positions.get(sel)!.x} y={layout.positions.get(sel)!.y}
              edge={selEdgeInfo} onClose={() => setSel(null)} />
          )}
        </svg>
      </div>
      <div className="shrink-0 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
        <span className="mr-3">实线：双向认识</span>
        <span className="mr-3">虚线+箭头：单向了解</span>
        <span>点击非中心节点查看对方视角的详细关系。</span>
      </div>
    </div>
  )
}
