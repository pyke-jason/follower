/* Terminal Variation 04 · DENSITY
   Maximum information density — 4-column grid with every panel
   visible at once. No scrolling required to see core structure.
   Uses the repo's color palette tightly for strategy + flag encoding. */

function TerminalDensity({ density = 'compact', gradeScale = 'A-F', showQuality = true }) {
  const trades = window.TRADES;
  const [sel, setSel] = React.useState(trades[trades.length - 1]);
  const stats = React.useMemo(() => window.computeStats(trades), [trades]);
  const byStrat = React.useMemo(() => window.groupBy(trades, 'strat').sort((a,b) => b.totalPnl - a.totalPnl), [trades]);

  const rBuckets = React.useMemo(() => {
    const buckets = [
      { label: '<-1R', min: -Infinity, max: -1, n: 0, neg: true },
      { label: '-1..0', min: -1, max: 0, n: 0, neg: true },
      { label: '0..+1', min: 0, max: 1, n: 0 },
      { label: '+1..+2', min: 1, max: 2, n: 0 },
      { label: '+2..+3', min: 2, max: 3, n: 0 },
      { label: '>+3R', min: 3, max: Infinity, n: 0 },
    ];
    for (const t of trades) for (const b of buckets) if (t.R > b.min && t.R <= b.max) { b.n++; break; }
    return buckets;
  }, [trades]);

  const byDow = React.useMemo(() => {
    const order = ['Mon','Tue','Wed','Thu','Fri'];
    return order.map(d => {
      const ts = trades.filter(t => t.dayOfWeek === d);
      return { d, pnl: ts.reduce((s,t) => s+t.pnl, 0), n: ts.length };
    });
  }, [trades]);

  const flagCounts = React.useMemo(() => {
    const c = {};
    for (const t of trades) for (const f of t.flags) c[f] = (c[f] || 0) + 1;
    return Object.entries(c).sort((a,b) => b[1] - a[1]);
  }, [trades]);

  const reconAlerts = React.useMemo(() => trades.filter(t => t.reconMismatch), [trades]);

  return (
    <div className="tv" data-density={density}>
      <div className="tv-hd">
        <span className="dot" />
        <span className="brand">TRADE·OS</span>
        <span className="sep">│</span>
        <span className="crumb">LAYOUT <b>density</b></span>
        <span className="sep">│</span>
        <span className="crumb">4-col · all metrics at-a-glance</span>
        <span className="push" />
        <span className="pill">Net {fmt$sign(stats.totalPnl)}</span>
        {reconAlerts.length > 0 && <span className="pill warn">{reconAlerts.length} RECON</span>}
        <span className="pill active">{trades.length} trades</span>
      </div>

      <div className="tv-density">
        {/* KPIs */}
        <div className="kpis">
          <KPI l="Net P&L" v={fmt$sign(stats.totalPnl)} tone={stats.totalPnl >= 0 ? 'pos' : 'neg'} s={`${stats.wins}W · ${stats.losses}L`} />
          <KPI l="Win Rate" v={(stats.winRate * 100).toFixed(1) + '%'} s={`exp ${fmt$sign(stats.expectancy)}`} />
          <KPI l="PF" v={stats.pf === Infinity ? '∞' : stats.pf.toFixed(2)} s="profit factor" />
          <KPI l="Expectancy" v={fmt$sign(stats.expectancy, 0)} tone={stats.expectancy >= 0 ? 'pos' : 'neg'} s="per trade" />
          <KPI l="Avg Win" v={fmt$sign(stats.avgWin)} tone="pos" s={`${stats.wins} wins`} />
          <KPI l="Avg Loss" v={fmt$sign(stats.avgLoss)} tone="neg" s={`${stats.losses} losses`} />
          <KPI l="Max DD" v={fmt$sign(stats.maxDD)} tone="neg" s="peak-to-trough" />
          <KPI l="Sharpe" v={stats.sharpe.toFixed(2)} s="weekly · annual" />
          <KPI l="Best" v={fmt$sign(stats.bestTrade.pnl)} tone="pos" s={stats.bestTrade.ticker} />
          <KPI l="Worst" v={fmt$sign(stats.worstTrade.pnl)} tone="neg" s={stats.worstTrade.ticker} />
        </div>

        {/* Equity curve */}
        <div className="equity tv-panel">
          <div className="tv-panel-hd">
            <span className="title">Equity curve</span>
            <span className="push" />
            <span>DD {fmt$sign(stats.maxDD)}</span>
          </div>
          <div className="tv-panel-bd" style={{ padding: 8 }}>
            <EquityCurve trades={trades} width={700} height={100} />
          </div>
        </div>

        {/* R distribution */}
        <div className="distro tv-panel">
          <div className="tv-panel-hd"><span className="title">R distribution</span></div>
          <div className="tv-panel-bd">
            <div className="tv-hist" style={{ padding: 6 }}>
              {(() => {
                const maxN = Math.max(...rBuckets.map(b => b.n), 1);
                return rBuckets.map((b, i) => (
                  <div key={i} className={cls('tv-hist-bar', b.neg && 'neg')}>
                    <div className="b" style={{ height: (b.n / maxN * 75) + '%' }} />
                    <div className="l" style={{fontSize: 8}}>{b.label}<br/>{b.n}</div>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>

        {/* Day-of-week */}
        <div className="dow tv-panel">
          <div className="tv-panel-hd"><span className="title">Day of week</span></div>
          <div className="tv-panel-bd">
            <div className="tv-hist" style={{ padding: 6 }}>
              {(() => {
                const maxAbs = Math.max(...byDow.map(d => Math.abs(d.pnl)), 1);
                return byDow.map((d, i) => (
                  <div key={i} className={cls('tv-hist-bar', d.pnl < 0 && 'neg')}>
                    <div className="b" style={{ height: (Math.abs(d.pnl) / maxAbs * 70) + '%' }} />
                    <div className="l" style={{fontSize: 8}}>{d.d}<br/>{fmt$sign(d.pnl)}</div>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>

        {/* Strategy bars */}
        <div className="strats tv-panel">
          <div className="tv-panel-hd"><span className="title">P&L by strategy</span></div>
          <div className="tv-panel-bd scroll">
            <StratBars rows={byStrat} />
          </div>
        </div>

        {/* Flag frequency */}
        <div className="flags tv-panel">
          <div className="tv-panel-hd"><span className="title">Flags</span><span className="push" /><span>{flagCounts.reduce((s,[,n])=>s+n,0)}</span></div>
          <div className="tv-panel-bd scroll">
            <div style={{ padding: '4px 0' }}>
              {flagCounts.map(([f, n]) => {
                const m = FLAG_META[f];
                if (!m) return null;
                const maxN = Math.max(...flagCounts.map(x => x[1]), 1);
                return (
                  <div key={f} className="tv-hbar-row" style={{ gridTemplateColumns: '80px 1fr 30px' }}>
                    <div className="l" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 10 }}>
                      <span className={`tv-flag ${m.tone}`}>{m.icon}</span>
                      <span>{f}</span>
                    </div>
                    <div className="bar">
                      <div className="fill pos" style={{ left: 0, width: (n / maxN * 100) + '%', background: m.tone === 'danger' ? 'var(--loss)' : m.tone === 'warn' ? 'var(--warning)' : 'var(--info)' }} />
                    </div>
                    <div className="v">{n}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Reconciliation */}
        <div className="recon tv-panel">
          <div className="tv-panel-hd"><span className="title">Recon mismatches</span><span className="push" /><span className="tv-warn">{reconAlerts.length}</span></div>
          <div className="tv-panel-bd scroll">
            {reconAlerts.length === 0 && <div style={{ padding: 10, color: 'var(--term-muted)', fontSize: 10 }}>All clear.</div>}
            {reconAlerts.map(t => {
              const delta = t.brokerPnl - t.pnl;
              return (
                <div key={t.id} className="tv-recon-row" style={{ gridTemplateColumns: '1fr auto' }} onClick={() => setSel(t)}>
                  <div>
                    <div className="tkr" style={{ fontSize: 10.5 }}>{t.ticker}</div>
                    <div className="l" style={{ fontSize: 9.5 }}>{fmtDate(t.exitDate)}</div>
                  </div>
                  <div className={`delta ${delta >= 0 ? 'tv-pos' : 'tv-neg'}`} style={{ fontSize: 10.5 }}>{fmt$sign(delta)}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Blotter (wide) */}
        <div className="blotter tv-panel">
          <div className="tv-panel-hd">
            <span className="title">Blotter</span>
            <span className="push" />
            <span>{trades.length} rows</span>
          </div>
          <div className="tv-panel-bd scroll">
            <table className="tv-tbl">
              <thead>
                <tr>
                  <th>CLOSE</th>
                  <th>TKR</th>
                  <th>STRATEGY</th>
                  <th>FLG</th>
                  <th className="r">RISK</th>
                  <th className="r">P&L</th>
                  <th className="r">R</th>
                  <th>R-BAR</th>
                  <th className="r">HOLD</th>
                  <th>TRADER</th>
                  {showQuality && <th>GR</th>}
                </tr>
              </thead>
              <tbody>
                {trades.slice().reverse().map(t => (
                  <tr key={t.id} className={sel.id === t.id ? 'sel' : ''} onClick={() => setSel(t)}>
                    <td style={{color: 'var(--term-muted)'}}>{fmtDate(t.exitDate)}</td>
                    <td className="tkr">{t.ticker}</td>
                    <td><Strat t={t} /></td>
                    <td><Flags flags={t.flags} /></td>
                    <td className="r" style={{color: 'var(--term-muted)'}}>{fmt$(t.maxRisk)}</td>
                    <td className="r"><PnL value={t.pnl} bold /></td>
                    <td className={`r ${t.R>=0 ? 'tv-pos' : 'tv-neg'}`}>{fmtR(t.R)}</td>
                    <td><RBar R={t.R} /></td>
                    <td className="r" style={{color: 'var(--term-muted)'}}>{t.daysHeld}d</td>
                    <td style={{color: 'var(--term-muted)', fontSize: 10}}>{t.trader}</td>
                    {showQuality && <td><Grade score={qualityScore(t)} scale={gradeScale} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Inspector */}
        <div className="inspector tv-panel">
          <div className="tv-panel-hd"><span className="title">Inspector</span><span className="push" /><span>#{sel.id}</span></div>
          <div className="tv-panel-bd scroll">
            <TradeDetailPanel t={sel} showQuality={showQuality} gradeScale={gradeScale} />
          </div>
        </div>
      </div>
    </div>
  );
}

window.TerminalDensity = TerminalDensity;
