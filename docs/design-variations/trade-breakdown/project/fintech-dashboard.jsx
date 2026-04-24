// Fintech — clean, airy, light-theme dashboard
// Prioritizes clarity and hierarchy. Summary hero → sections → table.

const FF = {
  fmt$: (n, s = true) => (n >= 0 ? (s ? '+' : '') : '-') + '$' + Math.abs(Math.round(n)).toLocaleString(),
  fmtPct: (n, d = 1) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%',
  fmtR: (r) => (r >= 0 ? '+' : '') + r.toFixed(2) + 'R',
  clsPnl: (n) => (n > 0 ? 'fn-pos' : n < 0 ? 'fn-neg' : 'fn-flat'),
};

function FintechDashboard() {
  const [view, setView] = React.useState('overview');
  const [selected, setSelected] = React.useState(null);
  const [filter, setFilter] = React.useState({ outcome: 'all', horizon: 'all' });

  const trades = window.TRADES;
  const filtered = trades.filter(t =>
    (filter.outcome === 'all' || (filter.outcome === 'wins' ? t.win : !t.win)) &&
    (filter.horizon === 'all' || t.horizon === filter.horizon)
  );
  const stats = window.computeStats(filtered);
  const byStrat = window.groupBy(filtered, 'strat').sort((a, b) => b.totalPnl - a.totalPnl);
  const byTicker = window.groupBy(filtered, 'ticker').sort((a, b) => b.totalPnl - a.totalPnl);
  const rankedByQuality = [...filtered].map(t => ({ ...t, q: window.qualityScore(t) })).sort((a, b) => b.q - a.q);
  const bestQ = rankedByQuality.slice(0, 3);
  const worstQ = rankedByQuality.slice(-3).reverse();

  return (
    <div className="fn">
      <div className="fn-nav">
        <div className="fn-brand">
          <div className="fn-logo" />
          <div>
            <div className="fn-name">Ledger</div>
            <div className="fn-sub">Trade analytics · Apr 2026</div>
          </div>
        </div>
        <div className="fn-tabs">
          {['overview', 'trades', 'risk', 'patterns'].map(v => (
            <button key={v} className={view === v ? 'fn-tab active' : 'fn-tab'} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className="fn-nav-r">
          <select className="fn-sel" value={filter.horizon} onChange={e => setFilter({ ...filter, horizon: e.target.value })}>
            <option value="all">All horizons</option>
            <option value="intraday">Intraday</option>
            <option value="swing">Swing</option>
            <option value="position">Position</option>
          </select>
          <select className="fn-sel" value={filter.outcome} onChange={e => setFilter({ ...filter, outcome: e.target.value })}>
            <option value="all">All trades</option>
            <option value="wins">Winners only</option>
            <option value="losses">Losers only</option>
          </select>
        </div>
      </div>

      {view === 'overview' && <FnOverview stats={stats} byStrat={byStrat} byTicker={byTicker} bestQ={bestQ} worstQ={worstQ} trades={filtered} onOpen={(t) => { setSelected(t); setView('trades'); }} />}
      {view === 'trades' && <FnTrades trades={filtered} selected={selected} setSelected={setSelected} />}
      {view === 'risk' && <FnRisk trades={filtered} stats={stats} />}
      {view === 'patterns' && <FnPatterns trades={filtered} />}
    </div>
  );
}

function FnOverview({ stats, byStrat, byTicker, bestQ, worstQ, trades, onOpen }) {
  return (
    <div className="fn-page">
      {/* Hero */}
      <div className="fn-hero">
        <div className="fn-hero-main">
          <div className="fn-hero-lbl">Net P&L · last 60 days</div>
          <div className={`fn-hero-v ${FF.clsPnl(stats.totalPnl)}`}>{FF.fmt$(stats.totalPnl)}</div>
          <div className="fn-hero-meta">
            <span className={FF.clsPnl(stats.totalPnl)}>{FF.fmtPct((stats.totalPnl / stats.totalRisk) * 100)}</span>
            <span>on ${Math.round(stats.totalRisk).toLocaleString()} total risk deployed</span>
          </div>
          <FnEquity stats={stats} />
        </div>
        <div className="fn-hero-side">
          <FnStat label="Win rate" value={(stats.winRate * 100).toFixed(0) + '%'} sub={`${stats.wins}W · ${stats.losses}L`} meter={stats.winRate} />
          <FnStat label="Expectancy" value={FF.fmt$(stats.expectancy, false)} sub="per trade" cls={FF.clsPnl(stats.expectancy)} />
          <FnStat label="Profit factor" value={stats.pf.toFixed(2)} sub="gross wins ÷ losses" cls={stats.pf >= 1.5 ? 'fn-pos' : stats.pf >= 1 ? 'fn-flat' : 'fn-neg'} />
          <FnStat label="Max drawdown" value={FF.fmt$(stats.maxDD)} sub="peak to trough" cls="fn-neg" />
        </div>
      </div>

      <div className="fn-grid-2">
        <FnCard title="What worked" sub="Highest-quality trades — composite of R-multiple, sizing, and IV at entry">
          <div className="fn-rank">
            {bestQ.map(t => <FnQualRow key={t.id} t={t} good onOpen={onOpen} />)}
          </div>
        </FnCard>
        <FnCard title="What hurt you" sub="Lowest-quality trades — where risk/reward was off, sizing drifted, or IV was punishing">
          <div className="fn-rank">
            {worstQ.map(t => <FnQualRow key={t.id} t={t} onOpen={onOpen} />)}
          </div>
        </FnCard>
      </div>

      <div className="fn-grid-2">
        <FnCard title="By strategy" sub="Which instrument types are actually working">
          <FnBarList rows={byStrat} />
        </FnCard>
        <FnCard title="By ticker" sub="Concentration of P&L across underlyings">
          <FnBarList rows={byTicker.slice(0, 8)} />
        </FnCard>
      </div>
    </div>
  );
}

function FnStat({ label, value, sub, cls = '', meter }) {
  return (
    <div className="fn-stat">
      <div className="fn-stat-l">{label}</div>
      <div className={`fn-stat-v ${cls}`}>{value}</div>
      {meter != null && <div className="fn-stat-meter"><div style={{ width: (meter * 100) + '%' }} /></div>}
      {sub && <div className="fn-stat-s">{sub}</div>}
    </div>
  );
}

function FnCard({ title, sub, children }) {
  return (
    <div className="fn-card">
      <div className="fn-card-hd">
        <div className="fn-card-t">{title}</div>
        {sub && <div className="fn-card-s">{sub}</div>}
      </div>
      <div className="fn-card-body">{children}</div>
    </div>
  );
}

function FnEquity({ stats }) {
  const data = stats.equity;
  const W = 720, H = 170, pad = { l: 0, r: 0, t: 10, b: 10 };
  const ys = data.map(d => d.cum);
  const yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys);
  const x = (i) => pad.l + (i / Math.max(1, data.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  const path = data.map((d, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(d.cum)).join(' ');
  const area = path + ` L ${x(data.length - 1)},${y(yMin)} L ${x(0)},${y(yMin)} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fn-eq" preserveAspectRatio="none">
      <defs>
        <linearGradient id="fn-eqfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#14b065" stopOpacity=".18" />
          <stop offset="100%" stopColor="#14b065" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="#e8e6df" strokeDasharray="3 3" />
      <path d={area} fill="url(#fn-eqfill)" />
      <path d={path} fill="none" stroke="#14b065" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function FnQualRow({ t, good = false, onOpen }) {
  const reasons = [];
  if (t.R >= 2) reasons.push('+' + t.R.toFixed(1) + 'R payoff');
  if (t.R <= -1) reasons.push('max-loss hit');
  if (t.iv != null && t.iv > 80 && /Long|Calendar/.test(t.strat)) reasons.push('paid high IV');
  if (t.iv != null && t.iv < 25 && /Spread|CSP|Condor|Covered/.test(t.strat)) reasons.push('sold cheap IV');
  if (t.maxRisk > MEDIAN_RISK * 2.5) reasons.push('oversized');
  if (t.maxRisk < MEDIAN_RISK * 0.5) reasons.push('conservative size');
  if (t.horizon === 'intraday' && !t.win) reasons.push('intraday chase');
  return (
    <div className="fn-qrow" onClick={() => onOpen(t)}>
      <div className={`fn-qscore ${good ? 'good' : 'bad'}`}>{t.q}</div>
      <div className="fn-qmain">
        <div className="fn-qtkr">
          <b>{t.ticker}</b> <span className="fn-qstrat">{t.strat}</span>
          <span className="fn-qdate">{t.entry.slice(5)}</span>
        </div>
        <div className="fn-qwhy">{reasons.slice(0, 3).join(' · ') || 'clean execution'}</div>
      </div>
      <div className={`fn-qpnl ${FF.clsPnl(t.pnl)}`}>
        {FF.fmt$(t.pnl)}
        <div className={`fn-qr ${FF.clsPnl(t.R)}`}>{FF.fmtR(t.R)}</div>
      </div>
    </div>
  );
}

function FnBarList({ rows }) {
  const max = Math.max(...rows.map(r => Math.abs(r.totalPnl)), 1);
  return (
    <div className="fn-bars">
      {rows.map(r => (
        <div key={r.key} className="fn-bar">
          <div className="fn-bar-head">
            <span className="fn-bar-k">{r.key}</span>
            <span className={`fn-bar-v ${FF.clsPnl(r.totalPnl)}`}>{FF.fmt$(r.totalPnl)}</span>
          </div>
          <div className="fn-bar-track">
            <div className="fn-bar-mid" />
            {r.totalPnl >= 0
              ? <div className="fn-bar-fill pos" style={{ left: '50%', width: `${(r.totalPnl / max) * 50}%` }} />
              : <div className="fn-bar-fill neg" style={{ right: '50%', width: `${(Math.abs(r.totalPnl) / max) * 50}%` }} />}
          </div>
          <div className="fn-bar-sub">{r.trades.length} trades · {(r.winRate * 100).toFixed(0)}% win · PF {isFinite(r.pf) ? r.pf.toFixed(2) : '∞'}</div>
        </div>
      ))}
    </div>
  );
}

function FnTrades({ trades, selected, setSelected }) {
  const [sort, setSort] = React.useState({ k: 'exitDate', d: -1 });
  const sorted = [...trades].sort((a, b) => {
    const av = a[sort.k], bv = b[sort.k];
    if (typeof av === 'string') return sort.d * av.localeCompare(bv);
    if (av instanceof Date) return sort.d * (av - bv);
    return sort.d * (av - bv);
  });
  const sel = selected || sorted[0];
  const hd = (k, label, align) => (
    <th style={{ textAlign: align || 'left' }} onClick={() => setSort(s => s.k === k ? { k, d: -s.d } : { k, d: -1 })}>
      {label}{sort.k === k ? (sort.d < 0 ? ' ↓' : ' ↑') : ''}
    </th>
  );
  return (
    <div className="fn-page">
      <div className="fn-trades-wrap">
        <div className="fn-card fn-trades-tbl">
          <div className="fn-card-hd">
            <div className="fn-card-t">{sorted.length} trades</div>
            <div className="fn-card-s">Click any row to inspect the full breakdown</div>
          </div>
          <table className="fn-tbl">
            <thead>
              <tr>
                {hd('exit', 'Closed')}{hd('ticker', 'Ticker')}{hd('strat', 'Strategy')}
                {hd('daysHeld', 'Days', 'right')}{hd('maxRisk', 'Risk', 'right')}
                {hd('pnl', 'P&L', 'right')}{hd('returnPct', 'Return', 'right')}
                {hd('R', 'R', 'right')}<th>Quality</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(t => {
                const q = window.qualityScore(t);
                return (
                  <tr key={t.id} className={sel && sel.id === t.id ? 'sel' : ''} onClick={() => setSelected(t)}>
                    <td>{t.exit.slice(5)}</td>
                    <td><b>{t.ticker}</b></td>
                    <td>{t.strat}</td>
                    <td style={{ textAlign: 'right' }}>{t.daysHeld}d</td>
                    <td style={{ textAlign: 'right' }}>${t.maxRisk.toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }} className={FF.clsPnl(t.pnl)}>{FF.fmt$(t.pnl)}</td>
                    <td style={{ textAlign: 'right' }} className={FF.clsPnl(t.returnPct)}>{FF.fmtPct(t.returnPct)}</td>
                    <td style={{ textAlign: 'right' }} className={FF.clsPnl(t.R)}>{FF.fmtR(t.R)}</td>
                    <td><FnQualChip v={q} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="fn-detail">
          {sel && <FnDetail t={sel} />}
        </div>
      </div>
    </div>
  );
}

function FnQualChip({ v }) {
  const grade = v >= 85 ? 'A' : v >= 70 ? 'B' : v >= 55 ? 'C' : v >= 40 ? 'D' : 'F';
  const cls = v >= 70 ? 'good' : v >= 55 ? 'neut' : 'bad';
  return <span className={`fn-qchip ${cls}`}>{grade}<span>{v}</span></span>;
}

function FnDetail({ t }) {
  const q = window.qualityScore(t);
  const tags = [];
  if (t.R >= 2) tags.push({ t: 'Big winner', c: 'good' });
  if (t.R <= -1) tags.push({ t: 'Max loss hit', c: 'bad' });
  if (t.iv > 80) tags.push({ t: 'High IV entry', c: 'warn' });
  if (t.maxRisk > MEDIAN_RISK * 2.5) tags.push({ t: 'Oversized', c: 'warn' });
  if (t.horizon === 'intraday' && !t.win) tags.push({ t: 'Intraday chase', c: 'bad' });
  return (
    <div className="fn-card fn-detail-card">
      <div className="fn-det-hd">
        <div>
          <div className="fn-det-tkr">{t.ticker}</div>
          <div className="fn-det-sub">{t.strat} · {t.legs}</div>
        </div>
        <div className={`fn-det-pnl ${FF.clsPnl(t.pnl)}`}>
          {FF.fmt$(t.pnl)}
          <div className={`fn-det-r ${FF.clsPnl(t.R)}`}>{FF.fmtR(t.R)} · {FF.fmtPct(t.returnPct)}</div>
        </div>
      </div>
      <div className="fn-det-tags">
        {tags.length === 0 ? <span className="fn-tag neut">clean trade</span> :
          tags.map((x, i) => <span key={i} className={`fn-tag ${x.c}`}>{x.t}</span>)}
      </div>
      <div className="fn-det-grid">
        <div><div className="fn-det-l">Entry</div><div className="fn-det-v">{t.entry}</div></div>
        <div><div className="fn-det-l">Exit</div><div className="fn-det-v">{t.exit}</div></div>
        <div><div className="fn-det-l">Days held</div><div className="fn-det-v">{t.daysHeld}</div></div>
        <div><div className="fn-det-l">Horizon</div><div className="fn-det-v">{t.horizon}</div></div>
        <div><div className="fn-det-l">Capital</div><div className="fn-det-v">${t.capital.toLocaleString()}</div></div>
        <div><div className="fn-det-l">Max risk</div><div className="fn-det-v">${t.maxRisk.toLocaleString()}</div></div>
        <div><div className="fn-det-l">Δ at entry</div><div className="fn-det-v">{t.delta?.toFixed(2)}</div></div>
        <div><div className="fn-det-l">IV at entry</div><div className="fn-det-v">{t.iv != null ? t.iv + '%' : '—'}</div></div>
        <div><div className="fn-det-l">POP at entry</div><div className="fn-det-v">{t.pop != null ? t.pop + '%' : '—'}</div></div>
        <div><div className="fn-det-l">Size vs. median</div><div className="fn-det-v">{(t.maxRisk / MEDIAN_RISK).toFixed(2)}×</div></div>
      </div>
      <div className="fn-det-qual">
        <div className="fn-det-qual-hd">
          <span>Quality score</span>
          <FnQualChip v={q} />
        </div>
        <div className="fn-det-qual-bar"><div style={{ width: q + '%' }} /></div>
        <div className="fn-det-qual-sub">
          Composite of R-multiple ({(t.R).toFixed(2)}R), sizing discipline, and IV at entry
        </div>
      </div>
      {t.notes && <div className="fn-det-notes">Notes · {t.notes}</div>}
    </div>
  );
}

function FnRisk({ trades, stats }) {
  return (
    <div className="fn-page">
      <div className="fn-grid-2">
        <FnCard title="Risk × Reward" sub="Where your P&L is coming from. Bigger bubbles = bigger positions. Aim for top-left: high R on small risk.">
          <FnScatter trades={trades} />
        </FnCard>
        <FnCard title="R-multiple distribution" sub="How your outcomes spread. A healthy edge skews right of zero.">
          <FnHist trades={trades} />
        </FnCard>
      </div>
      <FnCard title="Risk-adjusted leaderboard" sub="Sorted by quality score — not raw dollars. A big win on huge size can rank below a small win on tight size.">
        <FnLeaderboard trades={trades} />
      </FnCard>
    </div>
  );
}

function FnScatter({ trades }) {
  const W = 580, H = 300, pad = { l: 48, r: 14, t: 14, b: 32 };
  const xMax = Math.max(...trades.map(t => t.maxRisk)) * 1.1;
  const yMin = Math.min(-2, ...trades.map(t => t.R)) - 0.3;
  const yMax = Math.max(2, ...trades.map(t => t.R)) + 0.3;
  const x = (v) => pad.l + (Math.log10(v + 1) / Math.log10(xMax + 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fn-scatter">
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#d7d5cd" />
      {[-2, -1, 0, 1, 2, 3].map(v => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#eeece5" />
          <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fill="#98948a" fontSize="10">{v}R</text>
        </g>
      ))}
      {[100, 500, 2000, 10000].map(v => v < xMax && (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={pad.t} y2={H - pad.b} stroke="#eeece5" strokeDasharray="2 3" />
          <text x={x(v)} y={H - pad.b + 14} textAnchor="middle" fill="#98948a" fontSize="10">${v >= 1000 ? (v / 1000) + 'k' : v}</text>
        </g>
      ))}
      {trades.map(t => (
        <circle key={t.id} cx={x(t.maxRisk)} cy={y(t.R)} r={Math.max(4, Math.min(14, Math.sqrt(t.maxRisk / 80)))}
          fill={t.R >= 0 ? '#14b065' : '#dc4545'} fillOpacity=".55" stroke={t.R >= 0 ? '#14b065' : '#dc4545'} strokeOpacity=".8">
          <title>{t.ticker} {t.strat} · {FF.fmtR(t.R)} · ${t.maxRisk}</title>
        </circle>
      ))}
      <text x={(W) / 2} y={H - 6} textAnchor="middle" fill="#98948a" fontSize="10">Max risk ($, log scale)</text>
    </svg>
  );
}

function FnHist({ trades }) {
  const buckets = [{ min: -Infinity, max: -2, l: '≤-2R' }, { min: -2, max: -1, l: '-2..-1' },
    { min: -1, max: 0, l: '-1..0' }, { min: 0, max: 1, l: '0..+1' },
    { min: 1, max: 2, l: '+1..+2' }, { min: 2, max: Infinity, l: '≥+2R' }];
  const counts = buckets.map(b => trades.filter(t => t.R > b.min && t.R <= b.max).length);
  const max = Math.max(...counts, 1);
  return (
    <div className="fn-hist">
      {buckets.map((b, i) => (
        <div key={i} className="fn-hcol">
          <div className="fn-hcount">{counts[i]}</div>
          <div className="fn-hbar-wrap">
            <div className={`fn-hbar ${i < 3 ? 'neg' : 'pos'}`} style={{ height: `${(counts[i] / max) * 100}%` }} />
          </div>
          <div className="fn-hlbl">{b.l}</div>
        </div>
      ))}
    </div>
  );
}

function FnLeaderboard({ trades }) {
  const ranked = trades.map(t => ({ ...t, q: window.qualityScore(t) })).sort((a, b) => b.q - a.q);
  return (
    <div className="fn-lead">
      {ranked.slice(0, 10).map((t, i) => (
        <div key={t.id} className="fn-lrow">
          <div className="fn-lrank">#{i + 1}</div>
          <FnQualChip v={t.q} />
          <div className="fn-lmain">
            <div><b>{t.ticker}</b> · {t.strat}</div>
            <div className="fn-lsub">{t.legs} · {t.daysHeld}d · {FF.fmtR(t.R)}</div>
          </div>
          <div className={`fn-lpnl ${FF.clsPnl(t.pnl)}`}>{FF.fmt$(t.pnl)}</div>
        </div>
      ))}
    </div>
  );
}

function FnPatterns({ trades }) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const dow = days.map(d => {
    const ts = trades.filter(t => t.dayOfWeek === d);
    return { d, pnl: ts.reduce((s, t) => s + t.pnl, 0), n: ts.length, wr: ts.length ? ts.filter(t => t.win).length / ts.length : 0 };
  });
  const horizons = ['intraday', 'swing', 'position'];
  const byH = horizons.map(h => {
    const ts = trades.filter(t => t.horizon === h);
    const wins = ts.filter(t => t.win);
    return { h, n: ts.length, pnl: ts.reduce((s, t) => s + t.pnl, 0), wr: ts.length ? wins.length / ts.length : 0,
             avgR: ts.length ? ts.reduce((s, t) => s + t.R, 0) / ts.length : 0 };
  });

  return (
    <div className="fn-page">
      <div className="fn-grid-2">
        <FnCard title="Day of week" sub="When are you actually making money?">
          <div className="fn-dow">
            {dow.map(r => {
              const max = Math.max(...dow.map(x => Math.abs(x.pnl)), 1);
              return (
                <div key={r.d} className="fn-dcell">
                  <div className="fn-dbar">
                    <div className="fn-dzero" />
                    <div className={`fn-dfill ${r.pnl >= 0 ? 'pos' : 'neg'}`}
                      style={{ height: `${(Math.abs(r.pnl) / max) * 50}%`, [r.pnl >= 0 ? 'bottom' : 'top']: '50%' }} />
                  </div>
                  <div className="fn-dlbl">{r.d}</div>
                  <div className={`fn-dv ${FF.clsPnl(r.pnl)}`}>{FF.fmt$(r.pnl, false)}</div>
                  <div className="fn-ds">{r.n} · {(r.wr * 100).toFixed(0)}%</div>
                </div>
              );
            })}
          </div>
        </FnCard>
        <FnCard title="By holding period" sub="Different horizons need different edges">
          <div className="fn-horiz">
            {byH.map(h => (
              <div key={h.h} className="fn-hrow">
                <div className="fn-hname">{h.h}</div>
                <div className="fn-hgrid">
                  <div><div className="fn-hl">Trades</div><div className="fn-hv">{h.n}</div></div>
                  <div><div className="fn-hl">Win rate</div><div className="fn-hv">{(h.wr * 100).toFixed(0)}%</div></div>
                  <div><div className="fn-hl">Avg R</div><div className={`fn-hv ${FF.clsPnl(h.avgR)}`}>{h.avgR.toFixed(2)}</div></div>
                  <div><div className="fn-hl">P&L</div><div className={`fn-hv ${FF.clsPnl(h.pnl)}`}>{FF.fmt$(h.pnl)}</div></div>
                </div>
              </div>
            ))}
          </div>
        </FnCard>
      </div>
      <FnCard title="IV regime at entry" sub="Buying high-IV options is expensive. Are you getting paid for it?">
        <FnIVBuckets trades={trades.filter(t => t.iv != null)} />
      </FnCard>
    </div>
  );
}

function FnIVBuckets({ trades }) {
  const buckets = [
    { lbl: 'Low (<25)', test: t => t.iv < 25 },
    { lbl: 'Mid (25-50)', test: t => t.iv >= 25 && t.iv < 50 },
    { lbl: 'High (50-80)', test: t => t.iv >= 50 && t.iv < 80 },
    { lbl: 'Extreme (80+)', test: t => t.iv >= 80 },
  ];
  return (
    <div className="fn-iv">
      {buckets.map(b => {
        const ts = trades.filter(b.test);
        const pnl = ts.reduce((s, t) => s + t.pnl, 0);
        const wr = ts.length ? ts.filter(t => t.win).length / ts.length : 0;
        const avgR = ts.length ? ts.reduce((s, t) => s + t.R, 0) / ts.length : 0;
        return (
          <div key={b.lbl} className="fn-ivcell">
            <div className="fn-ivl">{b.lbl}</div>
            <div className={`fn-ivv ${FF.clsPnl(pnl)}`}>{FF.fmt$(pnl)}</div>
            <div className="fn-ivs">{ts.length} trades · {(wr * 100).toFixed(0)}% win · {avgR.toFixed(2)}R avg</div>
          </div>
        );
      })}
    </div>
  );
}

window.FintechDashboard = FintechDashboard;
