/* Variation 05 · BACKTEST RUN — shadcn rewrite
   Tailwind + shadcn Card/Badge/Tabs + Recharts. */

const {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip: ReTooltip, ReferenceLine, AreaChart, Area, BarChart, Bar, Cell,
  ComposedChart, Line, LineChart,
} = Recharts;

// Strategy palette — HSL to match shadcn vars
const STRAT_COLORS = {
  CALL: 'hsl(160 60% 50%)',
  PUT: 'hsl(0 75% 60%)',
  STOCK: 'hsl(210 75% 60%)',
  CDS: 'hsl(40 90% 55%)',
  PDS: 'hsl(275 70% 65%)',
};
const STRAT_LABELS = {
  CALL: 'Long call',
  PUT: 'Long put',
  STOCK: 'Stock / wheel',
  CDS: 'Call debit',
  PDS: 'Put debit',
};

function TerminalTraders() {
  const meta = React.useMemo(() => window.backtestMeta(), []);
  const trades = window.BACKTEST_TRADES;
  const byTrader = React.useMemo(() => window.pnlByTrader(), []);
  const byStrat = React.useMemo(() => window.pnlByStrategy(), []);
  const timeline = React.useMemo(() => window.openPositionsTimeline(), []);

  const [stratFilter, setStratFilter] = React.useState(null);

  const strats = ['CALL', 'PUT', 'STOCK', 'CDS', 'PDS'];
  const stratCounts = React.useMemo(() => {
    const c = { CALL: 0, PUT: 0, STOCK: 0, CDS: 0, PDS: 0 };
    trades.forEach(t => { c[t.strat]++; });
    return c;
  }, [trades]);

  const scatterData = React.useMemo(() => {
    const source = stratFilter ? trades.filter(t => t.strat === stratFilter) : trades;
    return source.filter(t => !t.isOpen).map(t => ({
      x: +t.exitDate,
      y: t.pnl,
      strat: t.strat,
      trader: t.trader,
      id: t.id,
      risk: t.maxRisk,
      size: Math.max(20, Math.min(140, Math.sqrt(Math.abs(t.pnl)) * 3)),
    }));
  }, [trades, stratFilter]);

  const lineData = React.useMemo(() => timeline.map(pt => ({
    date: +pt.date,
    open: pt.open,
    CALL: pt.byStrat.CALL,
    PUT: pt.byStrat.PUT,
    STOCK: pt.byStrat.STOCK,
    CDS: pt.byStrat.CDS,
    PDS: pt.byStrat.PDS,
  })), [timeline]);

  const btEndTs = +new Date('2025-09-30');

  return (
    <div className="flex flex-col h-full bg-background text-foreground font-mono-ui text-xs">
      {/* Topbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-semibold tracking-wider text-[11px]">BACKTEST/RUN</span>
          <span className="text-muted-foreground">//</span>
          <span className="text-foreground">2025-09-01 — 2025-09-30</span>
          <span className="text-muted-foreground">//</span>
          <span className="text-muted-foreground">{meta.model}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success">{meta.status}</Badge>
          <span className="text-muted-foreground">runtime {meta.runtime}</span>
          <span className="text-muted-foreground">data {meta.dataSize}</span>
          <span className="text-muted-foreground">msgs {meta.messages}</span>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-6 gap-px bg-border">
        <KpiCard label="Trades" value={meta.tradesTotal} sub={<span className="text-amber-400">+{meta.openCount} open</span>} />
        <KpiCard label="Win rate" value={`${(meta.winRate * 100).toFixed(1)}%`} sub="closed only" />
        <KpiCard
          label="Realized P&L"
          value={fmt$sign(meta.realizedPnl)}
          valueClass={meta.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          sub={<>gross {fmt$sign(meta.grossPnl)} · comm {fmt$(meta.commissions)}</>}
        />
        <KpiCard
          label="Unrealized"
          value={fmt$sign(meta.unrealizedPnl)}
          valueClass={meta.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          sub={`${meta.openCount} floating`}
        />
        <KpiCard label="Max DD" value={fmt$(meta.maxDD)} valueClass="text-rose-400" sub="closed equity" />
        <KpiCard label="Profit factor" value={meta.profitFactor.toFixed(2)} sub="gross win / loss" />
      </div>

      {/* Strategy legend / filter */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card/50">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Filter</span>
        <FilterChip active={!stratFilter} onClick={() => setStratFilter(null)} count={meta.tradesTotal}>All</FilterChip>
        {strats.map(s => (
          <FilterChip
            key={s}
            active={stratFilter === s}
            color={STRAT_COLORS[s]}
            onClick={() => setStratFilter(stratFilter === s ? null : s)}
            count={stratCounts[s]}
          >
            {STRAT_LABELS[s]}
          </FilterChip>
        ))}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
          click to drill in
        </span>
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-2 gap-px bg-border flex-1 min-h-0">
        {/* Scatter — full width */}
        <Card className="col-span-2 rounded-none border-0 border-b border-border">
          <CardHeader className="py-2.5 px-4 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[11px] uppercase tracking-wider">Per-trade P&L · colored by strategy</CardTitle>
            <CardDescription>{scatterData.length} closed trades · open excluded</CardDescription>
          </CardHeader>
          <CardContent className="p-0 pl-2 pr-4 pb-2 h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 8, bottom: 24, left: 8 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 3" vertical={false} />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={ts => fmtDate(new Date(ts))}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  stroke="hsl(var(--border))"
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  tickFormatter={v => fmt$sign(v, 0)}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  stroke="hsl(var(--border))"
                />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.5} />
                <ReTooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                {strats.map(s => (
                  <Scatter
                    key={s}
                    name={s}
                    data={scatterData.filter(d => d.strat === s)}
                    fill={STRAT_COLORS[s]}
                    fillOpacity={0.7}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Open positions line — full width */}
        <Card className="col-span-2 rounded-none border-0 border-b border-border">
          <CardHeader className="py-2.5 px-4 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[11px] uppercase tracking-wider">Open positions · end of run</CardTitle>
            <CardDescription className="flex items-center gap-2">
              ends at <span className="text-foreground font-semibold">{meta.openCount}</span> still open ·
              <Badge variant="warn">close-side lag</Badge>
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 pl-2 pr-4 pb-2 h-[170px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={lineData} margin={{ top: 8, right: 8, bottom: 24, left: 8 }}>
                <defs>
                  <linearGradient id="openGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(40 90% 55%)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="hsl(40 90% 55%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={ts => fmtDate(new Date(ts))}
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  stroke="hsl(var(--border))"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  stroke="hsl(var(--border))"
                  width={36}
                />
                <ReTooltip content={<OpenTooltip />} />
                <ReferenceLine x={btEndTs} stroke="hsl(142 72% 45%)" strokeDasharray="3 3" label={{ value: 'end of backtest', position: 'insideTopRight', fill: 'hsl(142 72% 45%)', fontSize: 10 }} />
                <Area type="monotone" dataKey="open" stroke="hsl(40 90% 55%)" strokeWidth={1.75} fill="url(#openGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* P&L by Trader */}
        <Card className="rounded-none border-0 border-r border-border">
          <CardHeader className="py-2.5 px-4 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[11px] uppercase tracking-wider">P&L by Trader</CardTitle>
            <CardDescription>humans we copy · ranked by realized $</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <RankedBars rows={byTrader} kind="trader" />
          </CardContent>
        </Card>

        {/* P&L by Strategy */}
        <Card className="rounded-none border-0">
          <CardHeader className="py-2.5 px-4 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[11px] uppercase tracking-wider">P&L by Strategy</CardTitle>
            <CardDescription>stock + wheels carry · long options bleed</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <RankedBars rows={byStrat} kind="strat" />
          </CardContent>
        </Card>
      </div>

      {/* Statusbar */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-t border-border bg-card text-[10px] text-muted-foreground">
        <span>LIVE {meta.tradersCount} feeds</span>
        <span>⏵ Izzytrader, Dave W, Brian H, ali_o, KaibosCowboy, Pete, ndRick, Sappur</span>
        <span className="text-border">|</span>
        <span>ORATS {meta.orats}</span>
        <span className="text-border">|</span>
        <span>COMM {meta.comm}</span>
        <span className="text-border">|</span>
        <span className="uppercase">{meta.risk}</span>
        <span className="ml-auto">↑↓ rank · ← → filter · ⏎ inspect</span>
      </div>
    </div>
  );
}

/* ─── KPI card (shadcn Card adapted for dense grid) ─── */
function KpiCard({ label, value, valueClass, sub }) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('text-2xl font-semibold tabular-nums tracking-tight mt-0.5', valueClass)}>{value}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{sub}</div>
    </div>
  );
}

/* ─── Filter chip (shadcn-button-ish) ─── */
function FilterChip({ children, active, color, count, onClick }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded border text-[10px] font-medium transition-colors',
        active
          ? 'bg-accent text-accent-foreground border-foreground/40'
          : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
      )}
    >
      {color && <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />}
      {!color && active && <span className="h-2.5 w-2.5 rounded-sm bg-foreground/70" />}
      <span>{children}</span>
      <span className="text-muted-foreground tabular-nums ml-0.5">{count}</span>
    </button>
  );
}

/* ─── Ranked diverging-bar list ─── */
function RankedBars({ rows, kind }) {
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.pnl)), 1);
  return (
    <div className="divide-y divide-border/60">
      {rows.map((r, i) => {
        const pct = (Math.abs(r.pnl) / maxAbs) * 48;
        const pos = r.pnl >= 0;
        const k = kind === 'trader' ? r.handle : r.key;
        return (
          <div key={k} className="grid grid-cols-[28px_1.2fr_2fr_1fr] gap-3 items-center px-4 py-2 hover:bg-muted/40">
            <div className="flex items-center justify-end">
              {kind === 'trader' ? (
                <span className="text-[10px] text-muted-foreground tabular-nums">{String(i + 1).padStart(2, '0')}</span>
              ) : (
                <span className="h-3 w-3 rounded-sm" style={{ background: STRAT_COLORS[r.key] }} />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground truncate">
                {kind === 'trader' ? r.name : STRAT_LABELS[r.key]}
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums truncate">
                {kind === 'trader' ? r.handle : r.key}
              </div>
            </div>
            <div className="relative h-3.5 bg-muted rounded overflow-hidden">
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border z-10" />
              <div
                className={cn('absolute top-0 bottom-0 rounded-sm', pos ? 'left-1/2 bg-emerald-500' : 'right-1/2 bg-rose-500')}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-right">
              <div className={cn('text-sm font-semibold tabular-nums', pos ? 'text-emerald-400' : 'text-rose-400')}>
                {fmt$sign(r.pnl)}
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums">
                {r.nClosed} · {(r.winRate * 100).toFixed(0)}% · {r.nOpen} open
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Tooltips ─── */
function ScatterTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded border border-border bg-popover px-3 py-2 shadow-xl text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className="h-2 w-2 rounded-sm" style={{ background: STRAT_COLORS[d.strat] }} />
        <span className="font-semibold">{d.id}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{d.trader}</span>
      </div>
      <div className="flex items-center justify-between gap-4 tabular-nums">
        <span className="text-muted-foreground">{STRAT_LABELS[d.strat]}</span>
        <span className={cn('font-semibold', d.y >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
          {fmt$sign(d.y)}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
        risked {fmt$(d.risk)} · closed {fmtDate(new Date(d.x))}
      </div>
    </div>
  );
}

function OpenTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-border bg-popover px-3 py-2 shadow-xl text-xs">
      <div className="text-muted-foreground text-[10px] mb-1">
        {fmtDate(new Date(label))}
      </div>
      <div className="flex items-center gap-4 tabular-nums">
        <span className="font-semibold text-amber-400">{payload[0].value} open</span>
      </div>
    </div>
  );
}

window.TerminalTraders = TerminalTraders;
window.STRAT_COLORS = STRAT_COLORS;
window.STRAT_LABELS = STRAT_LABELS;
