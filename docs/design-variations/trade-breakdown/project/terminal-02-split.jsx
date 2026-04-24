/* Terminal Variation 02 · SPLIT
   Left sidebar = ranked ticker cards with sparklines.
   Right pane = selected-ticker deep dive with its own equity,
   strategy mix, and per-ticker blotter. */

function TerminalSplit({ density = 'compact', gradeScale = 'A-F', showQuality = true }) {
  const trades = window.TRADES;
  const byTicker = React.useMemo(() => window.groupBy(trades, 'ticker')
    .sort((a, b) => b.totalPnl - a.totalPnl), [trades]);

  const [selTicker, setSelTicker] = React.useState(byTicker[0]?.key || null);
  const ticker = byTicker.find(g => g.key === selTicker) || byTicker[0];
  const tickerTrades = ticker.trades;
  const [selTrade, setSelTrade] = React.useState(tickerTrades[tickerTrades.length - 1]);

  React.useEffect(() => {
    setSelTrade(ticker.trades[ticker.trades.length - 1]);
  }, [selTicker]);

  const stats = window.computeStats(trades);
  const openIssues = trades.filter(t => t.reconMismatch || t.flags.includes('closeFailed')).length;

  // Per-ticker strategy mix
  const byStratLocal = React.useMemo(() => window.groupBy(tickerTrades, 'strat'), [ticker]);

  return (
    <div className="tv" data-density={density}>
      <div className="tv-hd">
        <span className="dot" />
        <span className="brand">TRADE·OS</span>
        <span className="sep">│</span>
        <span className="crumb">VIEW <b>by-ticker</b></span>
        <span className="sep">│</span>
        <span className="crumb">{byTicker.length} symbols · {trades.length} fills</span>
        <span className="push" />
        {openIssues > 0 && <span className="pill warn">{openIssues} RECON</span>}
        <span className="pill">Net {fmt$sign(stats.totalPnl)}</span>
        <span className="pill active">Win {(stats.winRate * 100).toFixed(0)}%</span>
      </div>

      <div className="tv-split">
        {/* SIDEBAR */}
        <div className="side">
          <div className="tv-panel side-panel" style={{ border: 'none' }}>
            <div className="tv-panel-hd">
              <span className="title">Symbols · ranked by net P&L</span>
              <span className="push" />
              <span>{byTicker.length}</span>
            </div>
            <div className="tv-panel-bd scroll">
              {byTicker.map(g => {
                let cum = 0;
                const curve = g.trades.map(t => { cum += t.pnl; return cum; });
                const ratio = g.wins / (g.wins + g.losses || 1);
                return (
                  <div key={g.key} className={cls('tv-sym-card', g.key === selTicker && 'sel')} onClick={() => setSelTicker(g.key)}>
                    <div className="row1">
                      <span className="tkr">{g.key}</span>
                      <span className={`pnl ${g.totalPnl >= 0 ? 'tv-pos' : 'tv-neg'}`}>{fmt$sign(g.totalPnl)}</span>
                    </div>
                    <div className="row2">
                      <span>{g.trades.length} trades · {(ratio * 100).toFixed(0)}% win</span>
                      <Spark values={curve} width={70} height={14} color={g.totalPnl >= 0 ? 'oklch(0.82 0.2 155)' : 'oklch(0.80 0.22 25)'} />
                    </div>
                    <div className="bar">
                      {g.trades.slice(-14).map((t, i) => (
                        <div key={i} className={cls('bar-seg', t.pnl > 0 ? 'win' : 'loss')} title={fmt$sign(t.pnl)} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* MAIN PANE */}
        <div className="main">
          {/* Header strip for selected ticker */}
          <div className="kpis" style={{ display: 'flex', background: 'oklch(0.16 0 0)' }}>
            <div className="tv-kpi" style={{ minWidth: 180 }}>
              <div className="tv-kpi-l">Symbol</div>
              <div className="tv-kpi-v" style={{ fontSize: 22, fontWeight: 700 }}>{ticker.key}</div>
              <div className="tv-kpi-s">{ticker.trades.length} closed trades</div>
            </div>
            <KPI l="Net P&L" v={fmt$sign(ticker.totalPnl)} tone={ticker.totalPnl >= 0 ? 'pos' : 'neg'} s={`${ticker.wins}W · ${ticker.losses}L`} />
            <KPI l="Win rate" v={(ticker.winRate * 100).toFixed(0) + '%'} s={`exp ${fmt$sign(ticker.expectancy)}`} />
            <KPI l="Profit factor" v={ticker.pf === Infinity ? '∞' : ticker.pf.toFixed(2)} s={`${fmt$sign(ticker.avgWin)} / ${fmt$sign(ticker.avgLoss)}`} />
            <KPI l="Best / Worst" v={fmt$sign(ticker.bestTrade.pnl) + ' / ' + fmt$sign(ticker.worstTrade.pnl)} s="single-trade extremes" />
            <KPI l="Avg hold" v={(ticker.trades.reduce((s,t) => s + t.daysHeld, 0) / ticker.trades.length).toFixed(1) + 'd'} s="days in position" />
          </div>

          {/* EQUITY + STRAT MIX */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 1, background: 'var(--term-border)' }}>
            <div className="tv-panel" style={{ border: 'none' }}>
              <div className="tv-panel-hd">
                <span className="title">{ticker.key} equity curve</span>
                <span className="push" />
                <span>DD {fmt$sign(ticker.maxDD)}</span>
              </div>
              <div className="tv-panel-bd" style={{ padding: 8 }}>
                <EquityCurve trades={tickerTrades} width={700} height={200} />
              </div>
            </div>
            <div className="tv-panel" style={{ border: 'none' }}>
              <div className="tv-panel-hd"><span className="title">Strategy mix</span></div>
              <div className="tv-panel-bd scroll">
                <StratBars rows={byStratLocal.sort((a,b)=>b.totalPnl-a.totalPnl)} />
              </div>
            </div>
          </div>

          {/* BLOTTER FOR SELECTED TICKER */}
          <div className="tv-panel" style={{ border: 'none' }}>
            <div className="tv-panel-hd">
              <span className="title">{ticker.key} blotter</span>
              <span>· chronological</span>
              <span className="push" />
              <span>{tickerTrades.length} rows</span>
            </div>
            <div className="tv-panel-bd scroll">
              <table className="tv-tbl">
                <thead>
                  <tr>
                    <th>ENTRY</th>
                    <th>EXIT</th>
                    <th>STRATEGY</th>
                    <th>FLG</th>
                    <th className="r">HOLD</th>
                    <th className="r">RISK</th>
                    <th className="r">P&L</th>
                    <th className="r">R</th>
                    <th>R-BAR</th>
                    {showQuality && <th>GR</th>}
                  </tr>
                </thead>
                <tbody>
                  {tickerTrades.slice().reverse().map(t => (
                    <tr key={t.id} className={selTrade.id === t.id ? 'sel' : ''} onClick={() => setSelTrade(t)}>
                      <td style={{color: 'var(--term-muted)'}}>{fmtDate(t.entryDate)}</td>
                      <td style={{color: 'var(--term-muted)'}}>{fmtDate(t.exitDate)}</td>
                      <td><Strat t={t} /></td>
                      <td><Flags flags={t.flags} /></td>
                      <td className="r" style={{color: 'var(--term-muted)'}}>{t.daysHeld}d</td>
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

          {/* INSPECTOR along bottom */}
          <div className="tv-panel" style={{ border: 'none' }}>
            <div className="tv-panel-hd">
              <span className="title">Inspector</span>
              <span className="push" />
              <span>#{selTrade.id}</span>
            </div>
            <div className="tv-panel-bd scroll">
              <TradeDetailPanel t={selTrade} showQuality={showQuality} gradeScale={gradeScale} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.TerminalSplit = TerminalSplit;
