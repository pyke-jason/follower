/* Terminal Variation 03 · TAPE
   Calendar-centric: weeks running vertically, each day shows
   every trade closed that day as colored chips. Hover/click a chip
   to inspect. Bottom pane is the standard blotter, right is
   flag-frequency counter. */

function TerminalTape({ density = 'compact', gradeScale = 'A-F', showQuality = true }) {
  const trades = window.TRADES;
  const stats = React.useMemo(() => window.computeStats(trades), [trades]);
  const [sel, setSel] = React.useState(trades[trades.length - 1]);

  // Bucket trades by YYYY-MM-DD of exit
  const byDay = React.useMemo(() => {
    const m = {};
    for (const t of trades) {
      const d = t.exitDate;
      const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      (m[k] = m[k] || []).push(t);
    }
    return m;
  }, [trades]);

  // Build weeks spanning first→last exit
  const weeks = React.useMemo(() => {
    const first = new Date(trades[0].exitDate);
    const last = new Date(trades[trades.length - 1].exitDate);
    // Start from Monday of first week
    const start = new Date(first);
    const dow = start.getDay() || 7; // treat Sunday as 7
    start.setDate(start.getDate() - (dow - 1));
    const weeksArr = [];
    let cur = new Date(start);
    while (cur <= last) {
      const days = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(cur);
        d.setDate(d.getDate() + i);
        const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        days.push({ date: d, key: k, trades: byDay[k] || [] });
      }
      weeksArr.push({ start: new Date(cur), days });
      cur.setDate(cur.getDate() + 7);
    }
    return weeksArr;
  }, [trades, byDay]);

  // Flag frequency roll-up
  const flagCounts = React.useMemo(() => {
    const c = {};
    for (const t of trades) for (const f of t.flags) c[f] = (c[f] || 0) + 1;
    return Object.entries(c).sort((a,b) => b[1] - a[1]);
  }, [trades]);

  // Per-day P&L sparkline (all days, including empty)
  const dayPnls = React.useMemo(() =>
    weeks.flatMap(w => w.days).map(d => d.trades.reduce((s,t) => s+t.pnl, 0))
  , [weeks]);

  return (
    <div className="tv" data-density={density}>
      <div className="tv-hd">
        <span className="dot" />
        <span className="brand">TRADE·OS</span>
        <span className="sep">│</span>
        <span className="crumb">VIEW <b>calendar tape</b></span>
        <span className="sep">│</span>
        <span className="crumb">{weeks.length} weeks · {trades.length} fills</span>
        <span className="push" />
        <span className="pill">Net {fmt$sign(stats.totalPnl)}</span>
        <span className="pill active">{trades.length} closed</span>
      </div>

      <div className="tv-tape">
        {/* Top KPI strip */}
        <div style={{ display: 'flex', background: 'oklch(0.16 0 0)', borderBottom: '1px solid var(--term-border)' }}>
          <KPI l="Net P&L" v={fmt$sign(stats.totalPnl)} tone={stats.totalPnl >= 0 ? 'pos' : 'neg'} s={`${stats.wins}W · ${stats.losses}L`} />
          <KPI l="Best day" v={(() => {
            const days = weeks.flatMap(w => w.days).map(d => ({ d: d.date, pnl: d.trades.reduce((s,t)=>s+t.pnl, 0) }));
            const best = days.reduce((b, x) => !b || x.pnl > b.pnl ? x : b, null);
            return fmt$sign(best.pnl);
          })()} s="single session" tone="pos" />
          <KPI l="Worst day" v={(() => {
            const days = weeks.flatMap(w => w.days).map(d => ({ d: d.date, pnl: d.trades.reduce((s,t)=>s+t.pnl, 0) }));
            const w = days.reduce((a, x) => !a || x.pnl < a.pnl ? x : a, null);
            return fmt$sign(w.pnl);
          })()} s="single session" tone="neg" />
          <KPI l="Streak" v={(() => {
            // Longest win/loss streak by trade order
            let best = 0, cur = 0, prev = null, bestSign = '';
            for (const t of trades) {
              const s = t.pnl >= 0 ? '+' : '-';
              if (s === prev) cur++; else cur = 1;
              if (cur > best) { best = cur; bestSign = s; }
              prev = s;
            }
            return `${best}${bestSign}`;
          })()} s="longest run" />
          <KPI l="Day sparkline" v={<Spark values={dayPnls} width={140} height={26} />} s="daily P&L" />
          <KPI l="Max DD" v={fmt$sign(stats.maxDD)} s="peak-to-trough" tone="neg" />
          <div style={{ flex: 1 }} />
        </div>

        {/* Middle: calendar + flags */}
        <div className="mid">
          {/* CALENDAR TAPE */}
          <div className="tv-panel" style={{ border: 'none' }}>
            <div className="tv-panel-hd">
              <span className="title">Calendar tape</span>
              <span>· chips sized by |R|, color by W/L</span>
              <span className="push" />
              <span>click to inspect</span>
            </div>
            <div className="tv-panel-bd scroll">
              <div className="tv-cal">
                <div className="tv-cal-week head">
                  <div className="wh" />
                  <div className="wh">Monday</div>
                  <div className="wh">Tuesday</div>
                  <div className="wh">Wednesday</div>
                  <div className="wh">Thursday</div>
                  <div className="wh">Friday</div>
                </div>
                {weeks.map((w, wi) => (
                  <div key={wi} className="tv-cal-week">
                    <div className="wh" style={{ fontWeight: 600, color: 'var(--term-fg-2)' }}>
                      {fmtDate(w.start)}
                    </div>
                    {w.days.map((d, di) => {
                      const daySum = d.trades.reduce((s,t) => s+t.pnl, 0);
                      return (
                        <div key={di} className={cls('tv-cal-day', d.date.getDay() === 0 || d.date.getDay() === 6 ? 'weekend' : '')}>
                          <div className="dt">{d.date.getDate()}</div>
                          {d.trades.length > 0 && <div className="sum" style={{ color: daySum >= 0 ? 'var(--profit)' : 'var(--loss)' }}>{fmt$sign(daySum)}</div>}
                          <div className="chips">
                            {d.trades.map(t => (
                              <span
                                key={t.id}
                                className={cls('chip', t.pnl >= 0 ? 'pos' : 'neg', sel.id === t.id && 'sel')}
                                onClick={() => setSel(t)}
                                style={sel.id === t.id ? { outline: '1px solid var(--term-fg-2)' } : null}
                                title={`${t.ticker} ${t.strat} ${fmt$sign(t.pnl)}`}
                              >
                                {t.ticker} {fmt$sign(t.pnl)}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT: flag counter + inspector */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--term-border)' }}>
            <div className="tv-panel" style={{ border: 'none', flex: '0 0 auto' }}>
              <div className="tv-panel-hd"><span className="title">Flag frequency</span><span className="push" /><span>{trades.reduce((s,t) => s+t.flags.length, 0)} total</span></div>
              <div className="tv-panel-bd">
                <div style={{ padding: '6px 0' }}>
                  {flagCounts.map(([f, n]) => {
                    const m = FLAG_META[f];
                    if (!m) return null;
                    const maxN = Math.max(...flagCounts.map(x => x[1]), 1);
                    return (
                      <div key={f} className="tv-hbar-row">
                        <div className="l" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span className={`tv-flag ${m.tone}`}>{m.icon}</span>
                          <span style={{ fontSize: 10.5 }}>{f}</span>
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
            <div className="tv-panel" style={{ border: 'none', flex: 1 }}>
              <div className="tv-panel-hd"><span className="title">Inspector</span><span className="push" /><span>#{sel.id}</span></div>
              <div className="tv-panel-bd scroll">
                <TradeDetailPanel t={sel} showQuality={showQuality} gradeScale={gradeScale} />
              </div>
            </div>
          </div>
        </div>

        {/* Bottom: blotter */}
        <div className="tv-panel" style={{ border: 'none' }}>
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
      </div>
    </div>
  );
}

window.TerminalTape = TerminalTape;
