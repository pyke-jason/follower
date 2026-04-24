/* Terminal Variation 01 · COMMAND
   Full command-center: KPI strip, equity curve + recon panel,
   blotter + inspector, distribution/strategies/day-of-week footer */

function TerminalCommand({ density = 'compact', gradeScale = 'A-F', showQuality = true }) {
  const trades = window.TRADES;
  const [sel, setSel] = React.useState(trades[trades.length - 1]);
  const stats = React.useMemo(() => window.computeStats(trades), [trades]);
  const byStrat = React.useMemo(() => window.groupBy(trades, 'strat').sort((a,b) => b.totalPnl - a.totalPnl), [trades]);

  // R distribution buckets
  const rBuckets = React.useMemo(() => {
    const buckets = [
      { label: '<-1R', min: -Infinity, max: -1, n: 0, neg: true },
      { label: '-1..0', min: -1, max: 0, n: 0, neg: true },
      { label: '0..+1', min: 0, max: 1, n: 0 },
      { label: '+1..+2', min: 1, max: 2, n: 0 },
      { label: '+2..+3', min: 2, max: 3, n: 0 },
      { label: '>+3R', min: 3, max: Infinity, n: 0 },
    ];
    for (const t of trades) {
      for (const b of buckets) if (t.R > b.min && t.R <= b.max) { b.n++; break; }
    }
    return buckets;
  }, [trades]);

  const byDow = React.useMemo(() => {
    const order = ['Mon','Tue','Wed','Thu','Fri'];
    return order.map(d => {
      const ts = trades.filter(t => t.dayOfWeek === d);
      const pnl = ts.reduce((s,t) => s+t.pnl, 0);
      return { d, pnl, n: ts.length };
    });
  }, [trades]);

  // Reconciliation alerts
  const reconAlerts = React.useMemo(() => trades.filter(t => t.reconMismatch).slice(-6), [trades]);
  const openIssues = reconAlerts.length + trades.filter(t => t.flags.includes('closeFailed')).length;

  return (
    <div className="tv" data-density={density}>
      <div className="tv-hd">
        <span className="dot" />
        <span className="brand">TRADE·OS</span>
        <span className="sep">│</span>
        <span className="crumb">DESK <b>retail-001</b></span>
        <span className="sep">│</span>
        <span className="crumb">BOOK <b>2024 Q4</b></span>
        <span className="sep">│</span>
        <span className="crumb">{trades.length} fills · {window.MEDIAN_RISK.toLocaleString()} median risk</span>
        <span className="push" />
        {openIssues > 0 && <span className="pill loss">● {openIssues} OPEN</span>}
        <span className="pill warn">LIVE</span>
        <span className="pill active">F1 HELP</span>
      </div>

      <div className="tv-cmd">
        {/* KPI STRIP */}
        <div className="kpis">
          <KPI l="Net P&L" v={fmt$sign(stats.totalPnl)} tone={stats.totalPnl >= 0 ? 'pos' : 'neg'} s={`${stats.wins}W · ${stats.losses}L`} />
          <KPI l="Win Rate" v={(stats.winRate * 100).toFixed(1) + '%'} s={`avg ${fmt$sign(stats.expectancy)}/trade`} />
          <KPI l="Profit Factor" v={stats.pf === Infinity ? '∞' : stats.pf.toFixed(2)} s={`${fmt$sign(stats.avgWin)} / ${fmt$sign(stats.avgLoss)}`} />
          <KPI l="Expectancy" v={fmt$sign(stats.expectancy, 0)} s="per trade" tone={stats.expectancy >= 0 ? 'pos' : 'neg'} />
          <KPI l="Max DD" v={fmt$sign(stats.maxDD)} s={`${(stats.maxDD / stats.totalPnl * 100).toFixed(0)}% of net`} tone="neg" />
          <KPI l="Sharpe (R-adj)" v={stats.sharpe.toFixed(2)} s="weekly · annualized" />
          <KPI l="Best" v={fmt$sign(stats.bestTrade.pnl)} s={`${stats.bestTrade.ticker} · ${fmtR(stats.bestTrade.R)}`} tone="pos" />
          <KPI l="Worst" v={fmt$sign(stats.worstTrade.pnl)} s={`${stats.worstTrade.ticker} · ${fmtR(stats.worstTrade.R)}`} tone="neg" />
        </div>

        {/* EQUITY CURVE */}
        <div className="equity tv-panel">
          <div className="tv-panel-hd">
            <span className="title">Equity curve</span>
            <span>·</span>
            <span>cumulative P&L by close date</span>
            <span className="push" />
            <span>DD {fmt$sign(stats.maxDD)}</span>
          </div>
          <div className="tv-panel-bd" style={{ position: 'relative', padding: 8 }}>
            <EquityCurve trades={trades} width={900} height={140} />
          </div>
        </div>

        {/* RECONCILIATION */}
        <div className="recon tv-panel">
          <div className="tv-panel-hd">
            <span className="title">Reconciliation</span>
            <span className="push" />
            <span className="tv-neg">{reconAlerts.length} mismatch</span>
          </div>
          <div className="tv-panel-bd scroll">
            {reconAlerts.length === 0 && <div style={{ padding: 10, color: 'var(--term-muted)', fontSize: 10.5 }}>All trades reconciled.</div>}
            {reconAlerts.map(t => {
              const delta = t.brokerPnl - t.pnl;
              return (
                <div key={t.id} className="tv-recon-row" onClick={() => setSel(t)}>
                  <div>
                    <div className="tkr">{t.ticker} <span style={{color: 'var(--term-muted)', fontWeight: 400, fontSize: 10}}>{t.strat}</span></div>
                    <div className="l">{fmtDate(t.exitDate)} · broker {fmt$sign(t.brokerPnl)} vs. sys {fmt$sign(t.pnl)}</div>
                  </div>
                  <div className={`delta ${delta >= 0 ? 'tv-pos' : 'tv-neg'}`}>{fmt$sign(delta)}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* BLOTTER */}
        <div className="blotter tv-panel">
          <div className="tv-panel-hd">
            <span className="title">Blotter</span>
            <span>· {trades.length} closed</span>
            <span className="push" />
            <span>sort ▼ close date</span>
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
                    {showQuality && <td><Grade score={qualityScore(t)} scale={gradeScale} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* INSPECTOR */}
        <div className="inspector tv-panel">
          <div className="tv-panel-hd">
            <span className="title">Inspector</span>
            <span className="push" />
            <span>#{sel.id}</span>
          </div>
          <div className="tv-panel-bd scroll">
            <TradeDetailPanel t={sel} showQuality={showQuality} gradeScale={gradeScale} />
          </div>
        </div>

        {/* FOOTER: 3 panels */}
        <div className="footer">
          <div className="tv-panel" style={{ border: 'none' }}>
            <div className="tv-panel-hd"><span className="title">R-multiple distribution</span></div>
            <div className="tv-panel-bd">
              <div className="tv-hist">
                {(() => {
                  const maxN = Math.max(...rBuckets.map(b => b.n), 1);
                  return rBuckets.map((b, i) => (
                    <div key={i} className={cls('tv-hist-bar', b.neg && 'neg')}>
                      <div className="b" style={{ height: (b.n / maxN * 85) + '%' }} />
                      <div className="l">{b.label}<br/>{b.n}</div>
                    </div>
                  ));
                })()}
              </div>
            </div>
          </div>
          <div className="tv-panel" style={{ border: 'none', borderLeft: '1px solid var(--term-border)' }}>
            <div className="tv-panel-hd"><span className="title">By strategy</span><span className="push" /><span>net $</span></div>
            <div className="tv-panel-bd scroll">
              <StratBars rows={byStrat} />
            </div>
          </div>
          <div className="tv-panel" style={{ border: 'none', borderLeft: '1px solid var(--term-border)' }}>
            <div className="tv-panel-hd"><span className="title">By day of week</span></div>
            <div className="tv-panel-bd">
              <div className="tv-hist">
                {(() => {
                  const maxAbs = Math.max(...byDow.map(d => Math.abs(d.pnl)), 1);
                  return byDow.map((d, i) => (
                    <div key={i} className={cls('tv-hist-bar', d.pnl < 0 && 'neg')}>
                      <div className="b" style={{ height: (Math.abs(d.pnl) / maxAbs * 75) + '%' }} />
                      <div className="l">{d.d}<br/>{fmt$sign(d.pnl)}</div>
                    </div>
                  ));
                })()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KPI({ l, v, s, tone }) {
  const toneCls = tone === 'pos' ? 'tv-pos' : tone === 'neg' ? 'tv-neg' : '';
  return (
    <div className="tv-kpi">
      <div className="tv-kpi-l">{l}</div>
      <div className={cls('tv-kpi-v', toneCls)}>{v}</div>
      <div className="tv-kpi-s">{s}</div>
    </div>
  );
}

function StratBars({ rows }) {
  const max = Math.max(...rows.map(r => Math.abs(r.totalPnl)), 1);
  return (
    <div style={{ padding: '4px 0' }}>
      {rows.map(r => (
        <div key={r.key} className="tv-hbar-row">
          <div className="l"><span className="tv-strat" data-k={stratColorKey(r.key)}>{r.key}</span></div>
          <div className="bar">
            <div className="zero" />
            <div className={`fill ${r.totalPnl >= 0 ? 'pos' : 'neg'}`} style={{ width: (Math.abs(r.totalPnl) / max * 50) + '%' }} />
          </div>
          <div className={`v ${r.totalPnl >= 0 ? 'tv-pos' : 'tv-neg'}`}>{fmt$sign(r.totalPnl)}</div>
        </div>
      ))}
    </div>
  );
}

// Re-derive client-side — mirrors trades-data.jsx
function stratColorKey(s) {
  if (/Bull Put|Put Credit/.test(s)) return 'pcs';
  if (/Bear Call|Call Credit/.test(s)) return 'ccs';
  if (/Bull Call|Call Debit/.test(s)) return 'cds';
  if (/Bear Put|Put Debit/.test(s)) return 'pds';
  if (/Long Call/.test(s)) return 'call';
  if (/Long Put/.test(s)) return 'put';
  if (/Shares/.test(s)) return 'stock';
  if (/Calendar|Condor/.test(s)) return 'pds';
  if (/CSP|Covered/.test(s)) return 'stock';
  return 'stock';
}

function Inspector({ t, showQuality, gradeScale }) {
  const q = qualityScore(t);
  const sizeRatio = t.maxRisk / window.MEDIAN_RISK;

  const autoTags = [];
  if (t.R > 1.5) autoTags.push({ l: 'big winner', tone: 'pos' });
  if (t.R < -0.9) autoTags.push({ l: 'max loss', tone: 'neg' });
  if (t.iv && t.iv > 80 && /Long|Calendar/.test(t.strat)) autoTags.push({ l: 'paid high IV', tone: 'warn' });
  if (t.iv && t.iv < 25 && /Long/.test(t.strat)) autoTags.push({ l: 'cheap vol', tone: 'info' });
  if (sizeRatio > 2) autoTags.push({ l: `oversized · ${sizeRatio.toFixed(1)}× median`, tone: 'warn' });
  if (sizeRatio < 0.5) autoTags.push({ l: 'conservative size', tone: 'info' });
  if (t.horizon === 'intraday' && t.pnl < 0) autoTags.push({ l: 'intraday flush', tone: 'neg' });
  if (q >= 85) autoTags.push({ l: 'A-grade setup', tone: 'pos' });
  if (t.flags.includes('chaseDanger')) autoTags.push({ l: 'heavy chase', tone: 'neg' });
  if (t.flags.includes('slippage')) autoTags.push({ l: `slippage ${fmt$(t.slippage)}`, tone: 'warn' });

  return (
    <div className="tv-insp" style={{ '--swatch': `var(--s-${t.stratKey})` }}>
      <div className="hd">
        <div>
          <div className="t">{t.ticker} <span style={{color: 'var(--term-muted)', fontSize: 11, fontWeight: 400}}>{t.strat}</span></div>
          <div style={{fontSize: 10, color: 'var(--term-muted)', marginTop: 2}}>
            <Flags flags={t.flags} />
          </div>
        </div>
        <div className={t.pnl >= 0 ? 'tv-pos p' : 'tv-neg p'}>{fmt$sign(t.pnl)}</div>
      </div>
      <div className="legs">{t.legs}</div>
      <div className="row"><span className="l">R-multiple</span><span className={`v ${t.R>=0?'tv-pos':'tv-neg'}`}>{fmtR(t.R)}</span></div>
      <div className="row"><span className="l">Max risk</span><span className="v">{fmt$(t.maxRisk)}</span></div>
      <div className="row"><span className="l">Size vs. median</span><span className="v">{sizeRatio.toFixed(2)}×</span></div>
      <div className="row"><span className="l">Return on risk</span><span className={`v ${t.returnPct>=0?'tv-pos':'tv-neg'}`}>{fmtPct(t.returnPct)}</span></div>
      <div className="row"><span className="l">Held</span><span className="v">{t.daysHeld}d · {t.horizon}</span></div>
      <div className="row"><span className="l">Entry IV</span><span className="v">{t.iv ?? '—'}{t.iv != null ? '%' : ''}</span></div>
      <div className="row"><span className="l">Entry → exit</span><span className="v">{fmtDate(t.entryDate)} → {fmtDate(t.exitDate)}</span></div>
      <div className="row"><span className="l">Trader</span><span className="v">{t.trader}</span></div>
      {t.reconMismatch && (
        <div className="row"><span className="l">Broker P&L</span><span className="v tv-warn">{fmt$sign(t.brokerPnl)} <small>(Δ {fmt$sign(t.brokerPnl - t.pnl)})</small></span></div>
      )}
      {showQuality && (
        <div className="row" style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid oklch(0.25 0 0)' }}>
          <span className="l">Quality</span>
          <span className="v"><Grade score={q} scale={gradeScale} /> <span style={{color: 'var(--term-muted)', fontSize: 10, marginLeft: 4}}>{q}/100</span></span>
        </div>
      )}
      <div className="tags">
        {autoTags.map((tg, i) => <span key={i} className={`tag ${tg.tone}`}>{tg.l}</span>)}
      </div>
    </div>
  );
}

window.TerminalCommand = TerminalCommand;
window._stratColorKey = stratColorKey;
window.Inspector = Inspector;
window.StratBars = StratBars;
window.KPI = KPI;
