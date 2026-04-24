// Terminal — dense, dark, Bloomberg-ish pro terminal
// All-on-one-screen. Monospace-forward. Tabular numerics. Green/red P&L.

const fmt$ = (n, s = true) => (n >= 0 ? (s ? '+' : '') : '-') + '$' + Math.abs(Math.round(n)).toLocaleString();
const fmt$2 = (n) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
const fmtPct = (n, d = 1) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
const fmtR = (r) => (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
const clsPnl = (n) => (n > 0 ? 'pnl-pos' : n < 0 ? 'pnl-neg' : 'pnl-flat');

function TerminalDashboard() {
  const [sortBy, setSortBy] = React.useState('pnl');
  const [dir, setDir] = React.useState(-1);
  const [selected, setSelected] = React.useState(null);
  const [strategyFilter, setStrategyFilter] = React.useState('ALL');

  const trades = window.TRADES;
  const filtered = strategyFilter === 'ALL' ? trades : trades.filter(t => t.strat === strategyFilter);
  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortBy], bv = b[sortBy];
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
  const stats = window.computeStats(filtered);
  const byStrat = window.groupBy(filtered, 'strat').sort((a, b) => b.totalPnl - a.totalPnl);
  const byTicker = window.groupBy(filtered, 'ticker').sort((a, b) => b.totalPnl - a.totalPnl);

  const sel = selected || sorted[0];

  const headerCell = (key, label, w) => (
    <th onClick={() => { if (sortBy === key) setDir(-dir); else { setSortBy(key); setDir(-1); } }}
        style={{ width: w, cursor: 'pointer', userSelect: 'none' }}>
      {label}{sortBy === key ? (dir < 0 ? ' ▼' : ' ▲') : ''}
    </th>
  );

  return (
    <div className="term">
      {/* Top status bar */}
      <div className="term-top">
        <div className="term-brand">
          <span className="blink">●</span> POSTMORTEM / TRADE ANALYTICS
          <span className="term-sep">│</span>
          <span style={{ opacity: .6 }}>v2.3 · acct #48-2931 · {new Date().toISOString().slice(0, 16).replace('T', ' ')}Z</span>
        </div>
        <div className="term-topright">
          <span>MKT: <span className="pnl-pos">OPEN</span></span>
          <span>SPY: 521.48 <span className="pnl-pos">+0.42%</span></span>
          <span>VIX: 14.2 <span className="pnl-neg">-2.1%</span></span>
          <span style={{ opacity: .5 }}>F1 HELP · F4 FILTER · F8 EXPORT</span>
        </div>
      </div>

      {/* KPI strip */}
      <div className="term-kpi">
        <KPI label="NET P&L" value={fmt$(stats.totalPnl)} cls={clsPnl(stats.totalPnl)} sub={`${filtered.length} trades`} />
        <KPI label="WIN RATE" value={(stats.winRate * 100).toFixed(1) + '%'} sub={`${stats.wins}W / ${stats.losses}L`} />
        <KPI label="EXPECTANCY" value={fmt$(stats.expectancy, false)} cls={clsPnl(stats.expectancy)} sub="per trade" />
        <KPI label="PROFIT FACTOR" value={stats.pf.toFixed(2)} cls={stats.pf >= 1.5 ? 'pnl-pos' : stats.pf >= 1 ? 'pnl-flat' : 'pnl-neg'} sub="gross W / gross L" />
        <KPI label="SHARPE" value={stats.sharpe.toFixed(2)} sub="weekly, risk-adj" />
        <KPI label="MAX DD" value={fmt$(stats.maxDD)} cls="pnl-neg" sub="peak to trough" />
        <KPI label="AVG WIN" value={fmt$(stats.avgWin)} cls="pnl-pos" sub="" />
        <KPI label="AVG LOSS" value={fmt$(stats.avgLoss)} cls="pnl-neg" sub="" />
        <KPI label="BEST" value={fmt$(stats.bestTrade.pnl)} cls="pnl-pos" sub={stats.bestTrade.ticker + ' ' + stats.bestTrade.strat.slice(0, 10)} />
        <KPI label="WORST" value={fmt$(stats.worstTrade.pnl)} cls="pnl-neg" sub={stats.worstTrade.ticker + ' ' + stats.worstTrade.strat.slice(0, 10)} />
      </div>

      {/* Main grid */}
      <div className="term-grid">
        {/* Equity curve */}
        <div className="panel p-eq">
          <PanelHeader title="EQUITY CURVE" right={<span style={{ opacity: .6 }}>cumulative P&L · {filtered.length} trades</span>} />
          <EquityCurve data={stats.equity} maxDD={stats.maxDD} onHover={setSelected} selected={sel} />
        </div>

        {/* Risk-return scatter */}
        <div className="panel p-scatter">
          <PanelHeader title="RISK × RETURN" right={<span style={{ opacity: .6 }}>risk (x) × R-multiple (y) · size = size</span>} />
          <RiskScatter trades={filtered} selected={sel} onSelect={setSelected} />
        </div>

        {/* Strategy breakdown */}
        <div className="panel p-strat">
          <PanelHeader title="BY STRATEGY" right={<span style={{ opacity: .6 }}>click to filter</span>} />
          <StrategyBars rows={byStrat} active={strategyFilter} onClick={(k) => setStrategyFilter(strategyFilter === k ? 'ALL' : k)} />
        </div>

        {/* Ticker breakdown */}
        <div className="panel p-tick">
          <PanelHeader title="BY TICKER" />
          <TickerBars rows={byTicker} />
        </div>

        {/* R-distribution */}
        <div className="panel p-dist">
          <PanelHeader title="R-MULTIPLE DIST" right={<span style={{ opacity: .6 }}>how often each R outcome</span>} />
          <RDistribution trades={filtered} />
        </div>

        {/* Day of week */}
        <div className="panel p-dow">
          <PanelHeader title="DAY OF WEEK" />
          <DayOfWeek trades={filtered} />
        </div>

        {/* Trade blotter */}
        <div className="panel p-blot">
          <PanelHeader title={`TRADE BLOTTER · ${sorted.length}`} right={
            <div style={{ display: 'flex', gap: 10 }}>
              {strategyFilter !== 'ALL' && (
                <button className="pill-chip active" onClick={() => setStrategyFilter('ALL')}>
                  strat: {strategyFilter} ✕
                </button>
              )}
              <span style={{ opacity: .6 }}>click row to inspect</span>
            </div>
          } />
          <div className="blot-scroll">
            <table className="blot">
              <thead>
                <tr>
                  {headerCell('id', 'ID', 64)}
                  {headerCell('entry', 'ENTRY', 88)}
                  {headerCell('ticker', 'TKR', 50)}
                  {headerCell('strat', 'STRATEGY', 140)}
                  <th style={{ width: 150 }}>LEGS</th>
                  {headerCell('daysHeld', 'DAYS', 48)}
                  {headerCell('maxRisk', 'RISK', 80)}
                  {headerCell('pnl', 'P&L $', 90)}
                  {headerCell('returnPct', 'RTN %', 70)}
                  {headerCell('R', 'R', 60)}
                  <th style={{ width: 60 }}>QUAL</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(t => {
                  const q = window.qualityScore(t);
                  return (
                    <tr key={t.id} className={sel && sel.id === t.id ? 'row-sel' : ''} onClick={() => setSelected(t)}>
                      <td className="mono-d">{t.id}</td>
                      <td className="mono-d">{t.entry.slice(5)}</td>
                      <td><b>{t.ticker}</b></td>
                      <td style={{ opacity: .9 }}>{t.strat}</td>
                      <td className="mono-d" style={{ opacity: .7 }}>{t.legs}</td>
                      <td className="num">{t.daysHeld}</td>
                      <td className="num">{'$' + t.maxRisk.toLocaleString()}</td>
                      <td className={`num ${clsPnl(t.pnl)}`}>{fmt$(t.pnl)}</td>
                      <td className={`num ${clsPnl(t.returnPct)}`}>{fmtPct(t.returnPct)}</td>
                      <td className={`num ${clsPnl(t.R)}`}>{fmtR(t.R)}</td>
                      <td className="num"><QualPill v={q} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Inspector */}
        <div className="panel p-insp">
          <PanelHeader title="INSPECTOR" right={<span style={{ opacity: .6 }}>{sel ? sel.id : '—'}</span>} />
          {sel && <Inspector t={sel} />}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="term-bottom">
        <span>FILTER: {strategyFilter}</span>
        <span>SORT: {sortBy} {dir < 0 ? '↓' : '↑'}</span>
        <span>SEL: {sel ? sel.id : '—'}</span>
        <span style={{ marginLeft: 'auto', opacity: .5 }}>READY</span>
      </div>
    </div>
  );
}

function KPI({ label, value, cls = '', sub }) {
  return (
    <div className="kpi">
      <div className="kpi-l">{label}</div>
      <div className={`kpi-v ${cls}`}>{value}</div>
      {sub && <div className="kpi-s">{sub}</div>}
    </div>
  );
}

function PanelHeader({ title, right }) {
  return (
    <div className="panel-hd">
      <span>{title}</span>
      <span>{right}</span>
    </div>
  );
}

function EquityCurve({ data, maxDD, onHover, selected }) {
  const W = 680, H = 210, pad = { l: 52, r: 12, t: 12, b: 22 };
  const xs = data.map((_, i) => i);
  const ys = data.map(d => d.cum);
  const yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys);
  const x = (i) => pad.l + (i / Math.max(1, data.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  const path = data.map((d, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(d.cum)).join(' ');
  const area = path + ` L ${x(data.length - 1)},${y(0)} L ${x(0)},${y(0)} Z`;

  // Running peak / drawdown shading
  let peak = 0;
  const ddSeg = data.map((d, i) => { peak = Math.max(peak, d.cum); return { x: x(i), y: y(d.cum), peak: y(peak) }; });

  // Y gridlines
  const ticks = 5;
  const tickVals = Array.from({ length: ticks + 1 }, (_, i) => yMin + (i / ticks) * (yMax - yMin));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="eq" preserveAspectRatio="none">
      <defs>
        <linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#0f9f5e" stopOpacity=".35" />
          <stop offset="100%" stopColor="#0f9f5e" stopOpacity="0" />
        </linearGradient>
      </defs>
      {tickVals.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#1e2a22" strokeDasharray="1 3" />
          <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fill="#6b7d72" fontSize="9" fontFamily="ui-monospace,monospace">
            {v >= 0 ? '+' : ''}{Math.round(v / 100) / 10}k
          </text>
        </g>
      ))}
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#2a4035" />
      <path d={area} fill="url(#eqfill)" />
      <path d={path} fill="none" stroke="#22cc7a" strokeWidth="1.5" />
      {/* markers — green for win, red for loss */}
      {data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.cum)} r={selected && selected.id === d.trade.id ? 4 : 2.5}
          fill={d.trade.win ? '#22cc7a' : '#e04b4b'} stroke={selected && selected.id === d.trade.id ? '#fff' : 'none'} strokeWidth="1"
          onMouseEnter={() => onHover(d.trade)} style={{ cursor: 'pointer' }} />
      ))}
      {/* x axis dates */}
      {data.filter((_, i) => i % Math.ceil(data.length / 6) === 0).map((d, i) => (
        <text key={i} x={x(data.indexOf(d))} y={H - 6} textAnchor="middle" fill="#6b7d72" fontSize="9" fontFamily="ui-monospace,monospace">
          {d.date.toISOString().slice(5, 10)}
        </text>
      ))}
      {/* drawdown label */}
      <text x={W - pad.r - 4} y={pad.t + 12} textAnchor="end" fill="#e04b4b" fontSize="10" fontFamily="ui-monospace,monospace">
        MAX DD {fmt$(maxDD)}
      </text>
    </svg>
  );
}

function RiskScatter({ trades, selected, onSelect }) {
  const W = 420, H = 260, pad = { l: 44, r: 14, t: 14, b: 26 };
  const xMax = Math.max(...trades.map(t => t.maxRisk)) * 1.1;
  const rs = trades.map(t => t.R);
  const yMin = Math.min(-2, ...rs) - 0.3, yMax = Math.max(2, ...rs) + 0.3;
  const x = (v) => pad.l + (Math.log10(v + 1) / Math.log10(xMax + 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const rad = (c) => Math.max(3, Math.min(11, Math.sqrt(c / 100)));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sc" preserveAspectRatio="none">
      {/* zero line */}
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#2a4035" />
      {/* quadrant labels */}
      <text x={pad.l + 6} y={pad.t + 12} fill="#22cc7a" fontSize="9" opacity=".5" fontFamily="ui-monospace,monospace">SMALL RISK · WIN</text>
      <text x={W - pad.r - 6} y={pad.t + 12} textAnchor="end" fill="#e0a84b" fontSize="9" opacity=".5" fontFamily="ui-monospace,monospace">BIG RISK · WIN</text>
      <text x={pad.l + 6} y={H - pad.b + 14} fill="#e04b4b" fontSize="9" opacity=".5" fontFamily="ui-monospace,monospace">SMALL RISK · LOSS</text>
      <text x={W - pad.r - 6} y={H - pad.b + 14} textAnchor="end" fill="#ff2e2e" fontSize="9" opacity=".7" fontFamily="ui-monospace,monospace">DANGER ZONE</text>

      {[-2, -1, 0, 1, 2, 3].map(v => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#1e2a22" strokeDasharray="1 3" />
          <text x={pad.l - 4} y={y(v) + 3} textAnchor="end" fill="#6b7d72" fontSize="9" fontFamily="ui-monospace,monospace">{v}R</text>
        </g>
      ))}
      {trades.map(t => (
        <circle key={t.id} cx={x(t.maxRisk)} cy={y(t.R)} r={rad(t.maxRisk)}
          fill={t.R > 0 ? '#22cc7a' : '#e04b4b'} fillOpacity={selected && selected.id === t.id ? .95 : .55}
          stroke={selected && selected.id === t.id ? '#fff' : 'none'} strokeWidth="1.5"
          onClick={() => onSelect(t)} style={{ cursor: 'pointer' }}>
          <title>{t.ticker} {t.strat} · {fmtR(t.R)} · risk {t.maxRisk}</title>
        </circle>
      ))}
      <text x={W - pad.r} y={H - 6} textAnchor="end" fill="#6b7d72" fontSize="9" fontFamily="ui-monospace,monospace">RISK $ (log) →</text>
    </svg>
  );
}

function StrategyBars({ rows, active, onClick }) {
  const max = Math.max(...rows.map(r => Math.abs(r.totalPnl)));
  return (
    <div className="bars">
      {rows.map(r => (
        <div key={r.key} className={`bar-row ${active === r.key ? 'active' : ''}`} onClick={() => onClick(r.key)}>
          <div className="bar-label">{r.key}</div>
          <div className="bar-track">
            <div className="bar-mid" />
            {r.totalPnl >= 0
              ? <div className="bar-fill pnl-pos-bg" style={{ left: '50%', width: `${(r.totalPnl / max) * 50}%` }} />
              : <div className="bar-fill pnl-neg-bg" style={{ right: '50%', width: `${(Math.abs(r.totalPnl) / max) * 50}%` }} />}
          </div>
          <div className={`bar-val ${clsPnl(r.totalPnl)}`}>{fmt$(r.totalPnl)}</div>
          <div className="bar-sub">{r.trades.length}t · {(r.winRate * 100).toFixed(0)}%</div>
        </div>
      ))}
    </div>
  );
}

function TickerBars({ rows }) {
  const max = Math.max(...rows.map(r => Math.abs(r.totalPnl)));
  return (
    <div className="bars">
      {rows.slice(0, 10).map(r => (
        <div key={r.key} className="bar-row">
          <div className="bar-label bold">{r.key}</div>
          <div className="bar-track">
            <div className="bar-mid" />
            {r.totalPnl >= 0
              ? <div className="bar-fill pnl-pos-bg" style={{ left: '50%', width: `${(r.totalPnl / max) * 50}%` }} />
              : <div className="bar-fill pnl-neg-bg" style={{ right: '50%', width: `${(Math.abs(r.totalPnl) / max) * 50}%` }} />}
          </div>
          <div className={`bar-val ${clsPnl(r.totalPnl)}`}>{fmt$(r.totalPnl)}</div>
          <div className="bar-sub">{r.trades.length}t</div>
        </div>
      ))}
    </div>
  );
}

function RDistribution({ trades }) {
  const buckets = [{ min: -Infinity, max: -2, label: '≤-2R' }, { min: -2, max: -1, label: '-2..-1' },
    { min: -1, max: 0, label: '-1..0' }, { min: 0, max: 1, label: '0..+1' },
    { min: 1, max: 2, label: '+1..+2' }, { min: 2, max: Infinity, label: '≥+2R' }];
  const counts = buckets.map(b => trades.filter(t => t.R > b.min && t.R <= b.max).length);
  const max = Math.max(...counts, 1);
  return (
    <div className="hist">
      {buckets.map((b, i) => (
        <div key={i} className="hist-col">
          <div className="hist-bar-wrap">
            <div className={`hist-bar ${i < 3 ? 'pnl-neg-bg' : 'pnl-pos-bg'}`} style={{ height: `${(counts[i] / max) * 100}%` }} />
            <div className="hist-count">{counts[i]}</div>
          </div>
          <div className="hist-lbl">{b.label}</div>
        </div>
      ))}
    </div>
  );
}

function DayOfWeek({ trades }) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const rows = days.map(d => {
    const ts = trades.filter(t => t.dayOfWeek === d);
    const pnl = ts.reduce((s, t) => s + t.pnl, 0);
    return { d, pnl, n: ts.length, wr: ts.length ? ts.filter(t => t.win).length / ts.length : 0 };
  });
  const max = Math.max(...rows.map(r => Math.abs(r.pnl)), 1);
  return (
    <div className="dow">
      {rows.map(r => (
        <div key={r.d} className="dow-cell">
          <div className="dow-lbl">{r.d}</div>
          <div className="dow-bar">
            <div className={`dow-fill ${clsPnl(r.pnl).replace('pnl-', 'pnl-') + '-bg'}`} style={{ height: `${(Math.abs(r.pnl) / max) * 100}%`, ...(r.pnl < 0 ? { bottom: 'auto', top: '50%' } : {}) }} />
            <div className="dow-zero" />
          </div>
          <div className={`dow-v ${clsPnl(r.pnl)}`}>{fmt$(r.pnl, false)}</div>
          <div className="dow-s">{r.n}t · {(r.wr * 100).toFixed(0)}%</div>
        </div>
      ))}
    </div>
  );
}

function QualPill({ v }) {
  const cls = v >= 75 ? 'pnl-pos' : v >= 50 ? 'pnl-flat' : 'pnl-neg';
  const grade = v >= 85 ? 'A' : v >= 70 ? 'B' : v >= 55 ? 'C' : v >= 40 ? 'D' : 'F';
  return <span className={`qual ${cls}`}>{grade} · {v}</span>;
}

function Inspector({ t }) {
  const q = window.qualityScore(t);
  const rows = [
    ['ID', t.id],
    ['ENTRY / EXIT', `${t.entry} → ${t.exit}`],
    ['HORIZON', t.horizon.toUpperCase()],
    ['DAYS HELD', t.daysHeld],
    ['LEGS', t.legs],
    ['CAPITAL', '$' + t.capital.toLocaleString()],
    ['MAX RISK', '$' + t.maxRisk.toLocaleString()],
    ['P&L', fmt$(t.pnl)],
    ['RETURN', fmtPct(t.returnPct)],
    ['R-MULTIPLE', fmtR(t.R)],
    ['DELTA @ ENTRY', t.delta?.toFixed(2)],
    ['IV @ ENTRY', t.iv != null ? t.iv + '%' : '—'],
    ['POP @ ENTRY', t.pop != null ? t.pop + '%' : '—'],
    ['SIZE vs MED', (t.maxRisk / window.MEDIAN_RISK).toFixed(2) + '×'],
  ];
  const tags = [];
  if (t.R >= 2) tags.push({ t: 'big-winner', c: 'pnl-pos' });
  if (t.R <= -1) tags.push({ t: 'max-loss', c: 'pnl-neg' });
  if (t.iv && t.iv > 80 && /Long|Calendar/.test(t.strat)) tags.push({ t: 'high-iv-long', c: 'warn' });
  if (t.maxRisk > window.MEDIAN_RISK * 2.5) tags.push({ t: 'oversized', c: 'warn' });
  if (t.horizon === 'intraday' && t.pnl < 0) tags.push({ t: 'chase', c: 'pnl-neg' });
  if (q >= 80) tags.push({ t: 'A-grade', c: 'pnl-pos' });

  return (
    <div className="insp">
      <div className="insp-hd">
        <div className="insp-t">{t.ticker} · {t.strat}</div>
        <div className={`insp-p ${clsPnl(t.pnl)}`}>{fmt$(t.pnl)}</div>
      </div>
      <div className="insp-legs">{t.legs}</div>
      <div className="insp-tags">
        {tags.length === 0 ? <span className="tag">clean</span> : tags.map((x, i) => <span key={i} className={`tag ${x.c}`}>{x.t}</span>)}
      </div>
      <div className="insp-rows">
        {rows.map(([k, v]) => (
          <div key={k} className="insp-row">
            <span className="insp-k">{k}</span>
            <span className="insp-v mono-d">{v}</span>
          </div>
        ))}
      </div>
      {t.notes && <div className="insp-notes">» {t.notes}</div>}
      <div className="insp-qual">
        <div className="insp-qual-hd">QUALITY SCORE</div>
        <div className="insp-qual-row">
          <QualPill v={q} />
          <div className="insp-qual-meter"><div className="insp-qual-fill" style={{ width: q + '%' }} /></div>
        </div>
      </div>
    </div>
  );
}

window.TerminalDashboard = TerminalDashboard;
