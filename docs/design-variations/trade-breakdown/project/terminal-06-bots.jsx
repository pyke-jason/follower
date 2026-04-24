/* Variation 06 · OPEN POSITIONS TIMELINE — shadcn rewrite
   Tailwind + shadcn + Recharts for the stacked strategy timeline. */

function TerminalBots() {
  const meta = React.useMemo(() => window.backtestMeta(), []);
  const timeline = React.useMemo(() => window.openPositionsTimeline(), []);
  const diag = React.useMemo(() => window.diagnoseOpenPositions(), []);

  const [selCat, setSelCat] = React.useState('past-plan');

  const diagList = [
    { key: 'holding',       tone: 'info' },
    { key: 'wheel-expiry',  tone: 'info' },
    { key: 'within-window', tone: 'info' },
    { key: 'past-plan',     tone: 'warn' },
  ];

  const selectedCat = diag[selCat];
  const selectedTrades = selectedCat?.trades || [];

  const {
    ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid,
    Tooltip: ReTooltip, ReferenceLine,
  } = Recharts;

  const stackData = React.useMemo(() => timeline.map(pt => ({
    date: +pt.date,
    CALL: pt.byStrat.CALL,
    PUT: pt.byStrat.PUT,
    STOCK: pt.byStrat.STOCK,
    CDS: pt.byStrat.CDS,
    PDS: pt.byStrat.PDS,
    total: pt.open,
  })), [timeline]);

  const btEndTs = +new Date('2025-09-30');
  const normalCount = diag['holding'].n + diag['wheel-expiry'].n + diag['within-window'].n;

  return (
    <div className="flex flex-col h-full bg-background text-foreground font-mono-ui text-xs">
      {/* Topbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
          <span className="font-semibold tracking-wider text-[11px]">BACKTEST/OPEN</span>
          <span className="text-muted-foreground">//</span>
          <span className="text-foreground">{meta.tradesTotal} trades</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-amber-400">{meta.openCount} still open at end of run</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="success">{meta.status}</Badge>
          <span className="text-muted-foreground">why are they still open?</span>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-6 gap-px bg-border">
        <KpiCard label="Open at end" value={meta.openCount} valueClass="text-amber-400" sub={`of ${meta.tradesTotal} · ${(meta.openCount / meta.tradesTotal * 100).toFixed(0)}%`} />
        <KpiCard
          label="Unrealized"
          value={fmt$sign(meta.unrealizedPnl)}
          valueClass={meta.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          sub="floating · not in P&L"
        />
        <KpiCard label="Normal (holds + wheels + in-window)" value={normalCount} sub="expected to be open" />
        <KpiCard label="Past planned exit" value={diag['past-plan'].n} valueClass="text-amber-400" sub={<span className="text-amber-400">close-side didn't fire</span>} />
        <KpiCard label="Capital trapped" value={fmt$(diag['past-plan'].risk, 0)} sub="in past-plan positions" />
        <KpiCard label="Action" value="REVIEW CLOSE LOGIC" valueClass="text-[14px] font-semibold text-foreground" sub="priority high" />
      </div>

      {/* Main grid: chart+list left, diagnosis right */}
      <div className="grid grid-cols-[1fr_360px] gap-px bg-border flex-1 min-h-0">
        {/* Timeline chart */}
        <Card className="rounded-none border-0 border-b border-border">
          <CardHeader className="py-2.5 px-4 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[11px] uppercase tracking-wider">Open positions over time · stacked by strategy</CardTitle>
            <div className="flex items-center gap-3">
              {['CALL','PUT','STOCK','CDS','PDS'].map(s => (
                <span key={s} className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: STRAT_COLORS[s], opacity: 0.6 }} />
                  {s}
                </span>
              ))}
            </div>
          </CardHeader>
          <CardContent className="p-0 pl-2 pr-4 pb-2 h-[340px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stackData} margin={{ top: 12, right: 12, bottom: 24, left: 8 }}>
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
                <ReTooltip content={<StackedTooltip />} />
                <ReferenceLine
                  x={btEndTs}
                  stroke="hsl(142 72% 45%)"
                  strokeDasharray="3 3"
                  label={{ value: `end of backtest · ${meta.openCount} open`, position: 'insideTopRight', fill: 'hsl(142 72% 45%)', fontSize: 10 }}
                />
                <Area type="monotone" dataKey="STOCK" stackId="1" stroke={STRAT_COLORS.STOCK} fill={STRAT_COLORS.STOCK} fillOpacity={0.4} />
                <Area type="monotone" dataKey="CDS"   stackId="1" stroke={STRAT_COLORS.CDS}   fill={STRAT_COLORS.CDS}   fillOpacity={0.4} />
                <Area type="monotone" dataKey="PDS"   stackId="1" stroke={STRAT_COLORS.PDS}   fill={STRAT_COLORS.PDS}   fillOpacity={0.4} />
                <Area type="monotone" dataKey="PUT"   stackId="1" stroke={STRAT_COLORS.PUT}   fill={STRAT_COLORS.PUT}   fillOpacity={0.4} />
                <Area type="monotone" dataKey="CALL"  stackId="1" stroke={STRAT_COLORS.CALL}  fill={STRAT_COLORS.CALL}  fillOpacity={0.4} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Diagnosis side panel (spans both rows) */}
        <Card className="row-span-2 rounded-none border-0 flex flex-col">
          <CardHeader className="py-2.5 px-4 flex-row items-center justify-between space-y-0 border-b border-border">
            <CardTitle className="text-[11px] uppercase tracking-wider">Why are they open?</CardTitle>
            <CardDescription>{meta.openCount} total</CardDescription>
          </CardHeader>
          <div className="flex-1 overflow-auto scrollbar-thin divide-y divide-border/60">
            {diagList.map(d => {
              const cat = diag[d.key];
              const isSel = selCat === d.key;
              const isWarn = d.tone === 'warn';
              return (
                <button
                  key={d.key}
                  onClick={() => setSelCat(d.key)}
                  className={cn(
                    'w-full text-left px-4 py-3 transition-colors relative',
                    isSel ? 'bg-muted/60' : 'hover:bg-muted/30',
                    isSel && (isWarn ? 'border-l-2 border-amber-500' : 'border-l-2 border-foreground/70')
                  )}
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex-1">
                      <div className={cn('text-2xl font-semibold tabular-nums leading-none', isWarn ? 'text-amber-400' : 'text-foreground')}>
                        {cat.n}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                        {cat.label}
                      </div>
                    </div>
                    <Badge variant={isWarn ? 'warn' : 'success'} className="shrink-0">
                      {isWarn ? 'REVIEW' : 'NORMAL'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground tabular-nums">
                    <span>{fmt$sign(cat.unreal, 0)} unreal.</span>
                    <span>{fmt$(cat.risk, 0)} at risk</span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="p-4 border-t border-border bg-muted/20">
            <div className="text-[10px] uppercase tracking-wider text-foreground/80 font-semibold mb-1.5">
              What the driver code should do
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Long option positions past their planned exit date should be auto-closed by the close-side of the copy driver. <span className="text-amber-400">{diag['past-plan'].n} trades</span> here skipped that — likely because the followed trader never posted an explicit "close" message and our driver only mirrors close signals, not planned expiries. Patch: add a TTL close-watcher that fires at <code className="text-foreground bg-background px-1 rounded">plannedExitDate + 0d</code>.
            </p>
          </div>
        </Card>

        {/* Trade list below chart */}
        <Card className="rounded-none border-0">
          <CardHeader className="py-2.5 px-4 flex-row items-center justify-between space-y-0 border-b border-border">
            <CardTitle className="text-[11px] uppercase tracking-wider">
              {selectedCat?.label} · {selectedTrades.length} positions
            </CardTitle>
            <CardDescription className="tabular-nums">
              total unreal {fmt$sign(selectedCat?.unreal || 0)} · cap. at risk {fmt$(selectedCat?.risk || 0)}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-auto scrollbar-thin max-h-[400px]">
            <OpenTradesTable trades={selectedTrades} endDate={new Date('2025-09-30')} isPastPlan={selCat === 'past-plan'} />
          </CardContent>
        </Card>
      </div>

      {/* Statusbar */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-t border-border bg-card text-[10px] text-muted-foreground">
        <span>LIVE 8 feeds · {meta.openCount} floating</span>
        <span className="text-border">|</span>
        <span className="text-amber-400">{diag['past-plan'].n} past-plan · close logic review</span>
        <span className="ml-auto">↑↓ category · ⏎ inspect · C copy ticker list</span>
      </div>
    </div>
  );
}

/* ─── Stacked tooltip ─── */
function StackedTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div className="rounded border border-border bg-popover px-3 py-2 shadow-xl text-xs">
      <div className="text-muted-foreground text-[10px] mb-1">{fmtDate(new Date(label))}</div>
      <div className="font-semibold text-foreground tabular-nums mb-1.5">{total} total open</div>
      <div className="space-y-0.5">
        {payload.slice().reverse().map(p => p.value > 0 && (
          <div key={p.dataKey} className="flex items-center justify-between gap-4 text-[11px]">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: p.color, opacity: 0.7 }} />
              <span className="text-muted-foreground">{p.dataKey}</span>
            </span>
            <span className="tabular-nums">{p.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Trades table (shadcn Table) ─── */
function OpenTradesTable({ trades, endDate, isPastPlan }) {
  const enriched = trades.map(t => {
    const daysSincePlan = Math.round((endDate - t.plannedExitDate) / 86400000);
    return { ...t, daysSincePlan };
  }).sort((a, b) => isPastPlan ? b.daysSincePlan - a.daysSincePlan : a.daysSincePlan - b.daysSincePlan);

  const show = enriched.slice(0, 50);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[70px]">ID</TableHead>
          <TableHead className="w-[110px]">Trader</TableHead>
          <TableHead className="w-[70px]">Strat</TableHead>
          <TableHead className="w-[80px]">Entered</TableHead>
          <TableHead className="w-[90px]">Planned</TableHead>
          <TableHead className="w-[80px] text-right">{isPastPlan ? 'Overdue' : 'Remaining'}</TableHead>
          <TableHead className="w-[90px] text-right">Risk</TableHead>
          <TableHead className="w-[100px] text-right">Unrealized</TableHead>
          <TableHead>Tag</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {show.map(t => {
          const overdue = t.daysSincePlan;
          return (
            <TableRow key={t.id}>
              <TableCell className="tabular-nums text-muted-foreground text-[10px]">{t.id}</TableCell>
              <TableCell className="text-[11px]">{t.trader}</TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1 text-[10px]">
                  <span className="h-2 w-2 rounded-sm" style={{ background: STRAT_COLORS[t.strat] }} />
                  {t.strat}
                </span>
              </TableCell>
              <TableCell className="tabular-nums text-[11px]">{fmtDate(t.entryDate)}</TableCell>
              <TableCell className="tabular-nums text-[11px]">{fmtDate(t.plannedExitDate)}</TableCell>
              <TableCell className={cn('tabular-nums text-right text-[11px]', isPastPlan && overdue > 0 && 'text-amber-400 font-medium')}>
                {isPastPlan
                  ? (overdue > 0 ? `+${overdue}d` : `${overdue}d`)
                  : (overdue < 0 ? `${Math.abs(overdue)}d` : 'due')}
              </TableCell>
              <TableCell className="tabular-nums text-right text-[11px]">{fmt$(t.maxRisk)}</TableCell>
              <TableCell className={cn('tabular-nums text-right text-[11px] font-medium', t.unrealized >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {fmt$sign(t.unrealized)}
              </TableCell>
              <TableCell>
                {t.openReason === 'past-plan' && <Badge variant="warn">close-side lag</Badge>}
                {t.openReason === 'wheel-expiry' && <Badge variant="info">expiry wait</Badge>}
                {t.openReason === 'holding' && <Badge variant="info">stock hold</Badge>}
                {t.openReason === 'within-window' && <Badge variant="outline">in-window</Badge>}
              </TableCell>
            </TableRow>
          );
        })}
        {enriched.length > show.length && (
          <TableRow>
            <TableCell colSpan={9} className="text-center text-muted-foreground text-[10px]">
              + {enriched.length - show.length} more · scroll or narrow
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

window.TerminalBots = TerminalBots;
