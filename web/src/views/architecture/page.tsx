import { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type NodeProps,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { buildInitialGraph, groupMap, palette } from './data';

/* ── invisible handle ────────────────────────────────────────────── */

const hs = '!w-1.5 !h-1.5 !min-w-0 !min-h-0 !bg-transparent !border-0';

/* ── ChipNode (collapsed expandable) ─────────────────────────────── */

function ChipNode({ data }: NodeProps<Node>) {
  const d = data as { label: string; subtitle: string; color: string };
  return (
    <>
      <Handle type="target" position={Position.Top} id="top" className={hs} />
      <Handle type="target" position={Position.Left} id="left" className={hs} />
      <div
        className="cursor-pointer rounded-lg border-l-[3px] bg-card px-3 py-2 shadow-sm transition-all hover:shadow-md"
        style={{ borderLeftColor: d.color }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold leading-tight text-card-foreground">{d.label}</div>
            <div className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground">{d.subtitle}</div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="pointer-events-none flex-shrink-0"
            style={{ color: d.color }}
            tabIndex={-1}
          >
            <Plus className="size-3" />
          </Button>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className={hs} />
      <Handle type="source" position={Position.Right} id="right" className={hs} />
    </>
  );
}

/* ── FrameNode (expanded parent) ─────────────────────────────────── */

function FrameNode({ data }: NodeProps<Node>) {
  const d = data as { label: string; color: string };
  return (
    <>
      <Handle type="target" position={Position.Top} id="top" className={hs} />
      <Handle type="target" position={Position.Left} id="left" className={hs} />
      <div
        className="h-full w-full cursor-pointer overflow-hidden rounded-lg border"
        style={{ borderColor: `color-mix(in srgb, ${d.color} 15%, transparent)`, boxShadow: `0 0 24px color-mix(in srgb, ${d.color} 6%, transparent)` }}
      >
        {/* Header */}
        <div
          className="flex h-[30px] items-center justify-between px-3"
          style={{ background: `color-mix(in srgb, ${d.color} 8%, transparent)` }}
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: d.color }}>
            {d.label}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="pointer-events-none"
            style={{ color: d.color }}
            tabIndex={-1}
          >
            <Minus className="size-3" />
          </Button>
        </div>
        {/* Body — children render on top via React Flow parentId */}
        <div className="w-full bg-background/40" style={{ height: 'calc(100% - 30px)' }} />
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className={hs} />
      <Handle type="source" position={Position.Right} id="right" className={hs} />
    </>
  );
}

/* ── SubNode (child within expanded frame) ───────────────────────── */

function SubNode({ data }: NodeProps<Node>) {
  const d = data as { label: string; desc: string; color: string };
  return (
    <>
      <Handle type="target" position={Position.Top} id="top" className={hs} />
      <Handle type="target" position={Position.Left} id="left" className={hs} />
      <div
        className="rounded-md border bg-card px-2 py-1.5"
        style={{ borderLeftColor: d.color, borderLeftWidth: 2, width: 110 }}
      >
        <div className="truncate text-[11px] font-medium leading-tight text-card-foreground">{d.label}</div>
        <div className="truncate text-[9px] leading-tight text-muted-foreground">{d.desc}</div>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className={hs} />
      <Handle type="source" position={Position.Right} id="right" className={hs} />
    </>
  );
}

/* ── LeafNode (non-expandable external) ──────────────────────────── */

function LeafNode({ data }: NodeProps<Node>) {
  const d = data as { label: string; subtitle: string; color: string };
  return (
    <>
      <Handle type="target" position={Position.Top} id="top" className={hs} />
      <Handle type="target" position={Position.Left} id="left" className={hs} />
      <div
        className="rounded-lg border border-dashed bg-card/50 px-3 py-2"
        style={{ borderColor: `color-mix(in srgb, ${d.color} 35%, transparent)` }}
      >
        <div className="truncate text-[13px] font-medium leading-tight" style={{ color: d.color }}>{d.label}</div>
        <div className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground">{d.subtitle}</div>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className={hs} />
      <Handle type="source" position={Position.Right} id="right" className={hs} />
    </>
  );
}

/* ── AnimatedFlowEdge (particles along hot path) ─────────────────── */

function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, style }: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 16,
  });
  const pathId = `fp-${id}`;
  const stroke = (style?.stroke as string) ?? palette.pipeline;

  return (
    <>
      <path d={edgePath} fill="none" stroke={stroke} strokeWidth={8} opacity={0.06} />
      <path id={pathId} d={edgePath} fill="none" stroke={stroke} strokeWidth={2} className="react-flow__edge-path" />
      <circle r="3.5" fill={stroke} opacity={0.85}>
        <animateMotion dur="2.8s" repeatCount="indefinite">
          <mpath xlinkHref={`#${pathId}`} />
        </animateMotion>
      </circle>
      <circle r="2" fill={stroke} opacity={0.45}>
        <animateMotion dur="2.8s" repeatCount="indefinite" begin="1.4s">
          <mpath xlinkHref={`#${pathId}`} />
        </animateMotion>
      </circle>
      {label && (
        <EdgeLabelRenderer>
          <Badge
            variant="outline"
            className="absolute rounded-sm border-primary/20 bg-background/90 px-1.5 py-0 font-mono text-[10px] text-primary"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`, pointerEvents: 'none' }}
          >
            {label as string}
          </Badge>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/* ── stable type registrations ───────────────────────────────────── */

const nodeTypes = { chip: ChipNode, frame: FrameNode, sub: SubNode, leaf: LeafNode };
const edgeTypes = { flow: FlowEdge };

/* ── legend ───────────────────────────────────────────────────────── */

function Legend() {
  return (
    <div className="absolute bottom-4 left-14 z-10 flex items-center gap-3 rounded-lg border bg-card/90 px-3 py-1.5 shadow-sm backdrop-blur-sm">
      <LegendItem color={palette.pipeline} label="Expandable" dashed={false} />
      <LegendItem color={palette.external} label="External" dashed />
      <div className="flex items-center gap-1.5">
        <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={palette.pipeline} strokeWidth="2" /></svg>
        <span className="text-[10px] text-muted-foreground">Hot path</span>
      </div>
      <div className="flex items-center gap-1.5">
        <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={palette.data} strokeWidth="1.5" /></svg>
        <span className="text-[10px] text-muted-foreground">Data write</span>
      </div>
      <div className="flex items-center gap-1.5">
        <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={palette.external} strokeWidth="1.5" strokeDasharray="4 2" /></svg>
        <span className="text-[10px] text-muted-foreground">External call</span>
      </div>
    </div>
  );
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`h-3 w-4 rounded-sm border-l-2 bg-card ${dashed ? 'border border-dashed' : ''}`}
        style={{ borderLeftColor: color, ...(dashed ? { borderColor: `color-mix(in srgb, ${color} 40%, transparent)` } : {}) }}
      />
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

/* ── main canvas ─────────────────────────────────────────────────── */

const { nodes: initNodes, edges: initEdges } = buildInitialGraph();

function ArchCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const { fitView } = useReactFlow();

  const toggle = useCallback((nodeId: string) => {
    const group = groupMap.get(nodeId);
    if (!group) return;

    const willExpand = !expandedIds.has(nodeId);

    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (willExpand) next.add(nodeId); else next.delete(nodeId);
      return next;
    });

    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === nodeId) {
          return {
            ...n,
            type: willExpand ? 'frame' : 'chip',
            style: willExpand ? { width: group.expanded.w, height: group.expanded.h } : undefined,
            data: { ...n.data, isExpanded: willExpand },
          };
        }
        if (n.parentId === nodeId) return { ...n, hidden: !willExpand };
        return n;
      }),
    );

    setEdges((eds) =>
      eds.map((e) => {
        if ((e.data as { parentGroup?: string })?.parentGroup === nodeId) {
          return { ...e, hidden: !willExpand };
        }
        return e;
      }),
    );

    setTimeout(() => fitView({ duration: 350, padding: 0.12 }), 30);
  }, [expandedIds, setNodes, setEdges, fitView]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (groupMap.has(node.id)) toggle(node.id);
  }, [toggle]);

  const minimapNodeColor = useMemo(
    () => (node: Node) => (node.data as { color?: string })?.color ?? 'var(--border)',
    [],
  );

  return (
    <div className="-mx-6 -mt-6 relative h-[calc(100vh-var(--banner-h,0px)-3.5rem)] bg-background">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
        minZoom={0.25}
        maxZoom={2.5}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="!bg-background" color="var(--border)" />
        <Controls
          showInteractive={false}
          className="!border-border !bg-card !shadow-sm [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-muted-foreground [&>button:hover]:!bg-accent"
        />
        <MiniMap
          nodeColor={minimapNodeColor}
          nodeStrokeWidth={0}
          maskColor="hsl(var(--background) / 0.5)"
          className="!border-border !bg-card"
        />
      </ReactFlow>

      <Legend />

      <div className="absolute left-4 top-4 z-10">
        <h1 className="text-base font-semibold text-foreground">System Architecture</h1>
        <p className="mt-0.5 text-[11px] text-muted-foreground">Click any service to expand its internals</p>
      </div>
    </div>
  );
}

/* ── page wrapper ────────────────────────────────────────────────── */

export default function ArchitecturePage() {
  return (
    <ReactFlowProvider>
      <ArchCanvas />
    </ReactFlowProvider>
  );
}
