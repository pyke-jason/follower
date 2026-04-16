import { useState, useMemo, useCallback } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type NodeProps,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Key, ArrowRight, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TableMeta } from '@src/local-api/db-browser-types';

// ── invisible handle style ─────────────────────────────

const hs = '!w-1.5 !h-1.5 !min-w-0 !min-h-0 !bg-transparent !border-0';

// ── TableNode ──────────────────────────────────────────

type TableNodeData = {
  table: TableMeta;
  selected: boolean;
  dimmed: boolean;
  onSelect: (name: string) => void;
};

function TableNode({ data }: NodeProps<Node>) {
  const d = data as TableNodeData;
  const { table, selected, dimmed, onSelect } = d;
  return (
    <>
      <Handle type="target" position={Position.Top} id="top" className={hs} />
      <Handle type="target" position={Position.Left} id="left" className={hs} />
      <div
        className={cn(
          'cursor-pointer rounded-lg border-l-[3px] bg-card shadow-sm transition-all hover:shadow-md min-w-[220px] max-w-[260px]',
          selected ? 'ring-2 ring-primary' : '',
          dimmed ? 'opacity-20' : '',
        )}
        style={{ borderLeftColor: 'var(--primary)' }}
        onClick={() => onSelect(table.name)}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/40">
          <span className="text-[13px] font-semibold leading-tight text-card-foreground truncate">{table.name}</span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">{table.rowCount}</Badge>
        </div>
        <div className="px-3 py-1.5 space-y-0.5">
          {table.columns.map((col) => {
            const isFk = table.foreignKeys.some((fk) => fk.column === col.name);
            return (
              <div key={col.name} className="flex items-center gap-1.5">
                {col.primaryKey && <Key className="size-2.5 shrink-0 text-amber-500" />}
                {isFk && !col.primaryKey && <ArrowRight className="size-2.5 shrink-0 text-blue-500" />}
                {!col.primaryKey && !isFk && <span className="size-2.5 shrink-0" />}
                <span className="text-[10px] text-card-foreground truncate">{col.name}</span>
                <span className="text-[10px] text-muted-foreground ml-auto shrink-0 font-mono">{col.type}</span>
              </div>
            );
          })}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" className={hs} />
      <Handle type="source" position={Position.Right} id="right" className={hs} />
    </>
  );
}

const nodeTypes = { table: TableNode };

// ── layout helper ──────────────────────────────────────

const COL_COUNT = 4;
const COL_W = 280;
const COL_GAP = 40;
const ROW_BASE = 40; // px for header
const COL_H = 16;   // px per column row
const ROW_GAP = 60;

function buildGraph(
  tables: TableMeta[],
  selectedTable: string,
  onSelectTable: (name: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  // Sort tables so those referenced by many FKs appear first (higher up)
  const refCounts = new Map<string, number>();
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      refCounts.set(fk.referencedTable, (refCounts.get(fk.referencedTable) ?? 0) + 1);
    }
  }
  const sorted = [...tables].sort((a, b) => (refCounts.get(b.name) ?? 0) - (refCounts.get(a.name) ?? 0));

  // Pre-compute heights and cumulative row Y offsets to prevent overlap
  const heights = sorted.map((t) => ROW_BASE + t.columns.length * COL_H);
  const rowCount = Math.ceil(sorted.length / COL_COUNT);
  const rowMaxHeights: number[] = [];
  for (let r = 0; r < rowCount; r++) {
    let maxH = 0;
    for (let c = 0; c < COL_COUNT; c++) {
      const idx = r * COL_COUNT + c;
      if (idx < heights.length) maxH = Math.max(maxH, heights[idx]);
    }
    rowMaxHeights.push(maxH);
  }
  const rowY: number[] = [0];
  for (let r = 1; r < rowCount; r++) {
    rowY.push(rowY[r - 1] + rowMaxHeights[r - 1] + ROW_GAP);
  }

  const nodes: Node[] = sorted.map((table, i) => {
    const col = i % COL_COUNT;
    const row = Math.floor(i / COL_COUNT);
    return {
      id: table.name,
      type: 'table',
      position: { x: col * (COL_W + COL_GAP), y: rowY[row] },
      data: { table, selected: table.name === selectedTable, onSelect: onSelectTable, dimmed: false },
      draggable: true,
    };
  });

  return { nodes, edges: buildEdges(tables) };
}

function buildEdges(tables: TableMeta[]): Edge[] {
  const edges: Edge[] = [];
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      edges.push({
        id: `${table.name}.${fk.column}->${fk.referencedTable}`,
        source: table.name,
        target: fk.referencedTable,
        type: 'smoothstep',
        style: { stroke: 'var(--muted-foreground)', strokeWidth: 1.5, opacity: 0.6 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 8, height: 8, color: 'var(--muted-foreground)' },
      });
    }
  }
  return edges;
}

// ── SchemaCanvas ───────────────────────────────────────

function SchemaCanvas({ tables, selectedTable, onSelectTable }: {
  tables: TableMeta[];
  selectedTable: string;
  onSelectTable: (name: string) => void;
}) {
  const [search, setSearch] = useState('');
  const { fitView } = useReactFlow();

  const { nodes: initNodes, edges: initEdges } = useMemo(
    () => buildGraph(tables, selectedTable, onSelectTable),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tables],
  );

  const [nodes, , onNodesChange] = useNodesState(initNodes);
  const [edges, , onEdgesChange] = useEdgesState(initEdges);

  const searchLower = search.toLowerCase();

  // Sync selected state + search dimming without rebuilding graph
  const syncedNodes = useMemo(
    () => nodes.map((n) => ({
      ...n,
      data: {
        ...(n.data as TableNodeData),
        selected: n.id === selectedTable,
        onSelect: onSelectTable,
        dimmed: searchLower.length > 0 && !n.id.toLowerCase().includes(searchLower),
      },
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, selectedTable, searchLower],
  );

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && search) {
      const matching = tables.filter((t) => t.name.toLowerCase().includes(searchLower));
      if (matching.length === 1) onSelectTable(matching[0].name);
      if (matching.length > 0) fitView({ nodes: matching.map((t) => ({ id: t.name })), padding: 0.3, duration: 300 });
    }
    if (e.key === 'Escape') {
      setSearch('');
      fitView({ padding: 0.15, duration: 300 });
    }
  }, [search, searchLower, tables, onSelectTable, fitView]);

  const clearSearch = useCallback(() => {
    setSearch('');
    fitView({ padding: 0.15, duration: 300 });
  }, [fitView]);

  const minimapColor = useCallback((node: Node) => {
    const d = node.data as TableNodeData;
    return d.selected ? 'var(--primary)' : 'var(--border)';
  }, []);

  return (
    <div className="h-full w-full bg-background relative">
      <div className="absolute top-3 left-3 z-10">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search tables…"
            className="w-52 h-8 text-xs bg-card/95 backdrop-blur-sm shadow-sm pl-7 pr-7"
          />
          {search && (
            <Button
              variant="ghost"
              size="xs"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 p-0"
              onClick={clearSearch}
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
      </div>
      <ReactFlow
        nodes={syncedNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} className="!bg-background" color="var(--border)" />
        <Controls
          showInteractive={false}
          className="!border-border !bg-card !shadow-sm [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-muted-foreground [&>button:hover]:!bg-accent"
        />
        <MiniMap
          nodeColor={minimapColor}
          nodeStrokeWidth={0}
          maskColor="hsl(var(--background) / 0.5)"
          className="!border-border !bg-card"
        />
      </ReactFlow>
    </div>
  );
}

// ── Public export ──────────────────────────────────────

export function SchemaGraph({ tables, selectedTable, onSelectTable }: {
  tables: TableMeta[];
  selectedTable: string;
  onSelectTable: (name: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <SchemaCanvas tables={tables} selectedTable={selectedTable} onSelectTable={onSelectTable} />
    </ReactFlowProvider>
  );
}
