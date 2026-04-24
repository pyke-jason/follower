import type { Node, Edge } from '@xyflow/react';

/* ── palette ─────────────────────────────────────────────────────── */

export const palette = {
  pipeline: '#3b82f6',
  external: '#f97316',
  data: '#10b981',
  alert: '#eab308',
  frontend: '#a78bfa',
} as const;

/* ── types ────────────────────────────────────────────────────────── */

type ChildDef = { id: string; label: string; desc: string; pos: { x: number; y: number } };
type InternalEdgeDef = { source: string; target: string; sh?: string; th?: string };

type GroupDef = {
  id: string;
  label: string;
  subtitle: string;
  color: string;
  position: { x: number; y: number };
  expanded: { w: number; h: number };
  children: ChildDef[];
  edges: InternalEdgeDef[];
};

type LeafDef = { id: string; label: string; subtitle: string; color: string; position: { x: number; y: number } };
type ExtEdgeDef = { source: string; target: string; label: string; hotPath?: boolean; dashed?: boolean; color?: string; sh?: string; th?: string };

/* ── groups (expandable) ─────────────────────────────────────────── */

const groups: GroupDef[] = [
  {
    id: 'ingestion', label: 'Ingestion', subtitle: 'Browser → SignalR → Dedup → DB',
    color: palette.pipeline, position: { x: 300, y: 130 }, expanded: { w: 490, h: 95 },
    children: [
      { id: 'ing-browser', label: 'Browser', desc: 'Playwright headless', pos: { x: 10, y: 42 } },
      { id: 'ing-signalr', label: 'SignalR', desc: 'WS listener inject', pos: { x: 130, y: 42 } },
      { id: 'ing-dedup', label: 'Dedup', desc: 'hash + classify', pos: { x: 250, y: 42 } },
      { id: 'ing-writer', label: 'Writer', desc: '→ messages table', pos: { x: 370, y: 42 } },
    ],
    edges: [
      { source: 'ing-browser', target: 'ing-signalr' },
      { source: 'ing-signalr', target: 'ing-dedup' },
      { source: 'ing-dedup', target: 'ing-writer' },
    ],
  },
  {
    id: 'orchestrator', label: 'Orchestrator', subtitle: 'Parser → Router → Resolve Paths',
    color: palette.pipeline, position: { x: 340, y: 400 }, expanded: { w: 400, h: 145 },
    children: [
      { id: 'orch-parser', label: 'Parser', desc: 'sync, zero I/O', pos: { x: 80, y: 40 } },
      { id: 'orch-router', label: 'Router', desc: 'precedence routing', pos: { x: 210, y: 40 } },
      { id: 'orch-open', label: 'Open Path', desc: 'market data', pos: { x: 10, y: 95 } },
      { id: 'orch-pos', label: 'Pos. Path', desc: 'DB positions', pos: { x: 145, y: 95 } },
      { id: 'orch-llm', label: 'LLM Path', desc: 'Claude agent', pos: { x: 280, y: 95 } },
    ],
    edges: [
      { source: 'orch-parser', target: 'orch-router' },
      { source: 'orch-router', target: 'orch-open', sh: 'bottom', th: 'top' },
      { source: 'orch-router', target: 'orch-pos', sh: 'bottom', th: 'top' },
      { source: 'orch-router', target: 'orch-llm', sh: 'bottom', th: 'top' },
    ],
  },
  {
    id: 'pipeline', label: 'Pipeline', subtitle: 'Risk → Size → Price → Chase',
    color: palette.pipeline, position: { x: 300, y: 620 }, expanded: { w: 490, h: 95 },
    children: [
      { id: 'pipe-risk', label: 'Risk', desc: 'limits + gates', pos: { x: 10, y: 42 } },
      { id: 'pipe-size', label: 'Sizing', desc: 'quantity calc', pos: { x: 130, y: 42 } },
      { id: 'pipe-price', label: 'Pricing', desc: 'midpoint + credit', pos: { x: 250, y: 42 } },
      { id: 'pipe-chase', label: 'Chase', desc: 'step + timeout', pos: { x: 370, y: 42 } },
    ],
    edges: [
      { source: 'pipe-risk', target: 'pipe-size' },
      { source: 'pipe-size', target: 'pipe-price' },
      { source: 'pipe-price', target: 'pipe-chase' },
    ],
  },
  {
    id: 'ordermgr', label: 'Order Manager', subtitle: 'Submit → Track → Chase → Fill',
    color: palette.pipeline, position: { x: 300, y: 800 }, expanded: { w: 490, h: 95 },
    children: [
      { id: 'ord-submit', label: 'Submit', desc: '→ broker API', pos: { x: 10, y: 42 } },
      { id: 'ord-track', label: 'Track', desc: 'working orders', pos: { x: 130, y: 42 } },
      { id: 'ord-tick', label: 'Tick', desc: '1s poll / manual', pos: { x: 250, y: 42 } },
      { id: 'ord-fill', label: 'Fill', desc: 'callback → record', pos: { x: 370, y: 42 } },
    ],
    edges: [
      { source: 'ord-submit', target: 'ord-track' },
      { source: 'ord-track', target: 'ord-tick' },
      { source: 'ord-tick', target: 'ord-fill' },
    ],
  },
  {
    id: 'brokers', label: 'Brokers', subtitle: 'Interface → IBKR / Sim',
    color: palette.pipeline, position: { x: 340, y: 980 }, expanded: { w: 400, h: 145 },
    children: [
      { id: 'brk-iface', label: 'Interface', desc: 'abstract contract', pos: { x: 145, y: 40 } },
      { id: 'brk-ibkr', label: 'IBKR', desc: 'Java sidecar :8090', pos: { x: 80, y: 95 } },
      { id: 'brk-sim', label: 'SimBroker', desc: 'backtest fills', pos: { x: 220, y: 95 } },
    ],
    edges: [
      { source: 'brk-iface', target: 'brk-ibkr', sh: 'bottom', th: 'top' },
      { source: 'brk-iface', target: 'brk-sim', sh: 'bottom', th: 'top' },
    ],
  },
  {
    id: 'datalayer', label: 'Data Layer', subtitle: 'Postgres + Drizzle',
    color: palette.data, position: { x: 950, y: 440 }, expanded: { w: 400, h: 145 },
    children: [
      { id: 'db-msgs', label: 'Messages', desc: 'chat input', pos: { x: 10, y: 40 } },
      { id: 'db-tasks', label: 'Tasks', desc: 'async queue', pos: { x: 145, y: 40 } },
      { id: 'db-trades', label: 'Trades', desc: 'positions + P&L', pos: { x: 280, y: 40 } },
      { id: 'db-decisions', label: 'Decisions', desc: 'orchestrator trace', pos: { x: 10, y: 95 } },
      { id: 'db-backtests', label: 'Backtests', desc: 'run results', pos: { x: 145, y: 95 } },
      { id: 'db-recon', label: 'Recon', desc: 'mismatch alerts', pos: { x: 280, y: 95 } },
    ],
    edges: [],
  },
  {
    id: 'recon', label: 'Reconciliation', subtitle: 'Broker vs DB every 5 min',
    color: palette.alert, position: { x: 20, y: 760 }, expanded: { w: 250, h: 145 },
    children: [
      { id: 'rec-compare', label: 'Reconciler', desc: 'broker vs DB', pos: { x: 10, y: 40 } },
      { id: 'rec-sweep', label: 'Fill Sweep', desc: 'stale fills', pos: { x: 130, y: 40 } },
      { id: 'rec-gate', label: 'Gate', desc: 'pre-trade block', pos: { x: 10, y: 95 } },
      { id: 'rec-expiry', label: 'Expiry', desc: 'option warnings', pos: { x: 130, y: 95 } },
    ],
    edges: [{ source: 'rec-compare', target: 'rec-gate', sh: 'bottom', th: 'top' }],
  },
  {
    id: 'frontend', label: 'Frontend', subtitle: 'React SPA → Query → Stores',
    color: palette.frontend, position: { x: 950, y: 40 }, expanded: { w: 490, h: 95 },
    children: [
      { id: 'fe-views', label: 'Views', desc: '13 lazy routes', pos: { x: 10, y: 42 } },
      { id: 'fe-adapters', label: 'Adapters', desc: 'multi-endpoint merge', pos: { x: 130, y: 42 } },
      { id: 'fe-query', label: 'Query', desc: 'TanStack cache', pos: { x: 250, y: 42 } },
      { id: 'fe-stores', label: 'Stores', desc: 'Zustand state', pos: { x: 370, y: 42 } },
    ],
    edges: [
      { source: 'fe-views', target: 'fe-adapters' },
      { source: 'fe-adapters', target: 'fe-query' },
      { source: 'fe-query', target: 'fe-stores' },
    ],
  },
  {
    id: 'api', label: 'API', subtitle: 'Hono REST @ :3791',
    color: palette.frontend, position: { x: 1020, y: 220 }, expanded: { w: 250, h: 145 },
    children: [
      { id: 'api-queries', label: 'Queries', desc: 'GET /web/*', pos: { x: 10, y: 40 } },
      { id: 'api-mutate', label: 'Mutations', desc: 'POST /web/*', pos: { x: 130, y: 40 } },
      { id: 'api-bt', label: 'Backtest', desc: 'spawn + cancel', pos: { x: 10, y: 95 } },
      { id: 'api-eval', label: 'Eval', desc: 'labels + review', pos: { x: 130, y: 95 } },
    ],
    edges: [],
  },
];

/* ── leaves (non-expandable) ─────────────────────────────────────── */

const leaves: LeafDef[] = [
  { id: 'chat', label: 'OneOption', subtitle: 'Live trading room', color: palette.external, position: { x: 380, y: 0 } },
  { id: 'runner', label: 'Task Runner', subtitle: 'Per-channel FIFO queue', color: palette.pipeline, position: { x: 380, y: 290 } },
  { id: 'claude', label: 'Claude API', subtitle: 'Anthropic LLM', color: palette.external, position: { x: 840, y: 480 } },
  { id: 'databento', label: 'Databento', subtitle: 'Market data ($$$)', color: palette.external, position: { x: 1000, y: 690 } },
  { id: 'alerts', label: 'Alerts', subtitle: 'Discord + Pushover', color: palette.alert, position: { x: 30, y: 1000 } },
  { id: 'tickcache', label: 'Tick Cache', subtitle: 'Postgres tick cache', color: palette.data, position: { x: 1000, y: 850 } },
];

/* ── external edges ──────────────────────────────────────────────── */

const extEdges: ExtEdgeDef[] = [
  // Hot path (animated)
  { source: 'chat', target: 'ingestion', label: 'raw HTML', hotPath: true },
  { source: 'ingestion', target: 'runner', label: 'Task', hotPath: true },
  { source: 'runner', target: 'orchestrator', label: 'Message', hotPath: true },
  { source: 'orchestrator', target: 'pipeline', label: 'Signal[]', hotPath: true },
  { source: 'pipeline', target: 'ordermgr', label: 'OrderParams', hotPath: true },
  { source: 'ordermgr', target: 'brokers', label: 'placeOrder()', hotPath: true },
  // Data writes
  { source: 'ingestion', target: 'datalayer', label: 'Message', color: palette.data, sh: 'right', th: 'left' },
  { source: 'ordermgr', target: 'datalayer', label: 'Trade', color: palette.data, sh: 'right', th: 'left' },
  { source: 'orchestrator', target: 'datalayer', label: 'Decision', color: palette.data, sh: 'right', th: 'left', dashed: true },
  // Frontend → API → DB
  { source: 'frontend', target: 'api', label: 'fetch /web/*', color: palette.frontend },
  { source: 'api', target: 'datalayer', label: 'queries', color: palette.frontend },
  // External API calls
  { source: 'orchestrator', target: 'claude', label: 'prompt', color: palette.external, dashed: true, sh: 'right', th: 'left' },
  { source: 'databento', target: 'tickcache', label: 'ticks ($$$)', color: palette.external, dashed: true },
  // Recon
  { source: 'recon', target: 'brokers', label: 'getPositions()', color: palette.alert, dashed: true, sh: 'right', th: 'left' },
  { source: 'recon', target: 'alerts', label: 'mismatches', color: palette.alert },
  { source: 'recon', target: 'datalayer', label: 'alerts', color: palette.alert, dashed: true, sh: 'right', th: 'left' },
];

/* ── lookup ──────────────────────────────────────────────────────── */

export const groupMap = new Map(groups.map((g) => [g.id, g]));

/* ── build initial react flow graph ──────────────────────────────── */

export function buildInitialGraph(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  for (const g of groups) {
    nodes.push({
      id: g.id, type: 'chip', position: g.position, zIndex: 0,
      data: { label: g.label, subtitle: g.subtitle, color: g.color, isExpanded: false },
    });
    for (const c of g.children) {
      nodes.push({
        id: c.id, type: 'sub', parentId: g.id, extent: 'parent' as const,
        position: c.pos, hidden: true, draggable: false, zIndex: 1,
        data: { label: c.label, desc: c.desc, color: g.color },
      });
    }
    for (const ie of g.edges) {
      edges.push({
        id: `i:${ie.source}:${ie.target}`, source: ie.source, target: ie.target,
        sourceHandle: ie.sh ?? 'right', targetHandle: ie.th ?? 'left',
        type: 'smoothstep', hidden: true, zIndex: 1,
        data: { parentGroup: g.id },
        style: { stroke: g.color, strokeWidth: 1.5, opacity: 0.5 },
      });
    }
  }

  for (const l of leaves) {
    nodes.push({ id: l.id, type: 'leaf', position: l.position, data: { label: l.label, subtitle: l.subtitle, color: l.color } });
  }

  for (const e of extEdges) {
    const stroke = e.color ?? palette.pipeline;
    edges.push({
      id: `e:${e.source}:${e.target}`, source: e.source, target: e.target,
      sourceHandle: e.sh ?? 'bottom', targetHandle: e.th ?? 'top',
      type: e.hotPath ? 'flow' : 'smoothstep', label: e.label,
      labelStyle: { fill: '#6e7681', fontSize: 10, fontFamily: 'ui-monospace, monospace' },
      labelBgStyle: { fill: '#0d1117', fillOpacity: 0.85 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      style: { stroke, strokeWidth: e.hotPath ? 2 : 1.5, ...(e.dashed ? { strokeDasharray: '6 3' } : {}) },
    });
  }

  return { nodes, edges };
}
