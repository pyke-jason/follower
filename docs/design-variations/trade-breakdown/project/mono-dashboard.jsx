// Mono — monochrome pro trader view. Slate/paper-neutral with a single
// amber/emerald accent pair. One-column narrative: hero summary → story →
// trade ledger. Feels like an editorial postmortem.

const MF = {
  fmt$: (n, s = true) => (n >= 0 ? (s ? '+' : '') : '-') + '$' + Math.abs(Math.round(n)).toLocaleString(),
  fmtPct: (n, d = 1) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%',
  fmtR: (r) => (r >= 0 ? '+' : '') + r.toFixed(2) + 'R',
  pnlCls: (n) => (n > 0 ? 'mn-up' : n < 0 ? 'mn-down' : 'mn-flat'),
};

function MonoDashboard() {
  const trades = window.TRADES;
  const stats = window.computeStats(trades);
  const byStrat = window.groupBy(trades, 'strat').sort((a, b) => b.totalPnl - a.totalPnl);
  const bestT = [...trades].sort((a, b) => b.pnl - a.pnl)[0];
  const worstT = [...trades].sort((a, b) => a.pnl - b.pnl)[0];
  const ranked = trades.map(t => ({ ...t, q: window.qualityScore(t) })).sort((a, b) => b.q - a.q);

  return (
    <div className="mn">
      {/* Header */}
      <header className="mn-hd">
        <div className="mn-hd-l">
          <div className="mn-eyebrow">Postmortem · 30 days · closed</div>
          <h1 className="mn-h1">Trade Breakdown</h1>
        </div>
        <div className="mn-hd-r">
          <div>Apr 24, 2026 · acct #48-2931</div>
          <div className="mn-hd-links"><a>Export CSV</a><span>·</span><a>Share</a><span>·</span><a>Print</a></div>
        </div>
      </header>

      {/* Hero summary — P&L, win rate, PF, dd. Newspaper grid */}
      <section className="mn-hero">
        <div className="mn-hero-big">
          <div className="mn-lbl">Net P&L</div>
          <div className={`mn-num-xl ${MF.pnlCls(stats.totalPnl)}`}>{MF.fmt$(stats.totalPnl)}</div>
          <div className="mn-meta">
            <span className={MF.pnlCls(stats.totalPnl)}>{MF.fmtPct((stats.totalPnl / stats.totalRisk) * 100)}</span>
            <span className="mn-dot">·</span>
            <span>on ${Math.round(stats.totalRisk).toLocaleString()} risk deployed · {trades.length} trades</span>
          </div>
        </div>
        <div className="mn-hero-stat">
          <div className="mn-lbl">Win rate</div>
          <div className="mn-num-lg">{(stats.winRate * 100).toFixed(0)}<span>%</span></div>
          <div className="mn-meta">{stats.wins} winners · {stats.losses} losers</div>
        </div>
        <div className="mn-hero-stat">
          <div className="mn-lbl">Profit factor</div>
          <div className={`mn-num-lg ${stats.pf >= 1.5 ? 'mn-up' : stats.pf >= 1 ? 'mn-flat' : 'mn-down'}`}>{stats.pf.toFixed(2)}</div>
          <div className="mn-meta">gross wins ÷ losses</div>
        </div>
        <div className="mn-hero-stat">
          <div className="mn-lbl">Expectancy</div>
          <div className={`mn-num-lg ${MF.pnlCls(stats.expectancy)}`}>{MF.fmt$(stats.expectancy, false)}</div>
          <div className="mn-meta">per trade · Sharpe {stats.sharpe.toFixed(2)}</div>
        </div>
        <div className="mn-hero-stat">
          <div className="mn-lbl">Max drawdown</div>
          <div className="mn-num-lg mn-down">{MF.fmt$(stats.maxDD)}</div>
          <div className="mn-meta">peak to trough</div>
        </div>
      </section>

      {/* Equity + R histogram */}
      <section className="mn-row mn-row-2">
        <div className="mn-box">
          <div className="mn-box-hd">
            <div className="mn-box-t">Equity curve</div>
            <div className="mn-box-s">Cumulative P&L · {trades.length} closed trades</div>
          </div>
          <MonoEquity stats={stats} />
        </div>
        <div className="mn-box">
          <div className="mn-box-hd">
            <div className="mn-box-t">Outcome shape</div>
            <div className="mn-box-s">Distribution of R-multiples — right-skew = edge</div>
          </div>
          <MonoDist trades={trades} />
        </div>
      </section>

      {/* Narrative */}
      <section className="mn-row mn-row-2">
        <div className="mn-box">
          <div className="mn-box-hd">
            <div className="mn-box-t">What's working</div>
            <div className="mn-box-s">Your three highest-quality trades</div>
          </div>
          <div className="mn-cards">
            {ranked.slice(0, 3).map(t => <MonoTradeCard key={t.id} t={t} />)}
          </div>
        </div>
        <div className="mn-box">
          <div className="mn-box-hd">
            <div className="mn-box-t">What's costing you</div>
            <div className="mn-box-s">Three lowest-quality trades — patterns to break</div>
          </div>
          <div className="mn-cards">
            {ranked.slice(-3).reverse().map(t => <MonoTradeCard key={t.id} t={t} bad />)}
          </div>
        </div>
      </section>

      {/* Strategy breakdown + Risk scatter */}
      <section className="mn-row mn-row-2">
        <div className="mn-box">
          <div className="mn-box-hd">
            <div className="mn-box-t">Strategy breakdown</div>
            <div className="mn-box-s">Which instrument types are actually earning their risk</div>
          </div>
          <MonoStratTable rows={byStrat} />
        </div>
        <div className="mn-box">
          <div className="mn-box-hd">
            <div className="mn-box-t">Risk × return</div>
            <div className="mn-box-s">Every bubble is a trade. Watch the bottom-right — big risk, losses.</div>
          </div>
          <MonoScatter trades={trades} />
        </div>
      </section>

      {/* Ledger */}
      <section className="mn-box mn-ledger">
        <div className="mn-box-hd">
          <div className="mn-box-t">Ledger</div>
          <div className="mn-box-s">All {trades.length} trades, ranked by quality score</div>
        </div>
        <table className="mn-tbl">
          <thead>
            <tr><th>#</th><th>Closed</th><th>Ticker</th><th>Strategy</th><th>Legs</th>
              <th style={{textAlign:'right'}}>Risk</th><th style={{textAlign:'right'}}>P&L</th>
              <th style={{textAlign:'right'}}>R</th><th style={{textAlign:'right'}}>Days</th>
              <th>Tags</th><th style={{textAlign:'right'}}>Quality</th></tr>
          </thead>
          <tbody>
            {ranked.map((t, i) => (
              <tr key={t.id}>
                <td className="mn-rank">{i + 1}</td>
                <td>{t.exit.slice(5)}</td>
                <td><b>{t.ticker}</b></td>
                <td>{t.strat}</td>
                <td className="mn-legs">{t.legs}</td>
                <td style={{textAlign:'right'}}>${t.maxRisk.toLocaleString()}</td>
                <td style={{textAlign:'right'}} className={MF.pnlCls(t.pnl)}>{MF.fmt$(t.pnl)}</td>
                <td style={{textAlign:'right'}} className={MF.pnlCls(t.R)}>{MF.fmtR(t.R)}</td>
                <td style={{textAlign:'right'}}>{t.daysHeld}</td>
                <td><MonoTags t={t} compact /></td>
                <td style={{textAlign:'right'}}><MonoQ v={t.q} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function MonoEquity({ stats }) {
  const data = stats.equity;
  const W = 700, H = 220, pad = { l: 42, r: 14, t: 14, b: 26 };
  const ys = data.map(d => d.cum);
  const yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys);
  const x = (i) => pad.l + (i / Math.max(1, data.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  const path = data.map((d, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(d.cum)).join(' ');

  // underwater segments
  let peak = 0;
  const uw = data.map(d => { peak = Math.max(peak, d.cum); return peak - d.cum; });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mn-eq" preserveAspectRatio="none">
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const v = yMin + f * (yMax - yMin);
        return (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#e7e4dc" />
            <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fill="#999387" fontSize="10">
              {(v >= 0 ? '+' : '') + (v / 1000).toFixed(1) + 'k'}
            </text>
          </g>
        );
      })}
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#c8c3b6" />
      <path d={path} fill="none" stroke="#1c1915" strokeWidth="1.8" strokeLinejoin="round" />
      {data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.cum)} r="2.8"
          fill={d.trade.win ? '#0b7a49' : '#b33a3a'} stroke="#fbfaf7" strokeWidth="1" />
      ))}
      {data.filter((_, i) => i % Math.ceil(data.length / 6) === 0).map((d, i) => (
        <text key={i} x={x(data.indexOf(d))} y={H - 6} textAnchor="middle" fill="#999387" fontSize="10">
          {d.date.toISOString().slice(5, 10)}
        </text>
      ))}
    </svg>
  );
}

function MonoDist({ trades }) {
  const buckets = [{ min: -Infinity, max: -2, l: '≤ -2R' }, { min: -2, max: -1, l: '-2..-1' },
    { min: -1, max: 0, l: '-1..0' }, { min: 0, max: 1, l: '0..+1' },
    { min: 1, max: 2, l: '+1..+2' }, { min: 2, max: Infinity, l: '≥ +2R' }];
  const counts = buckets.map(b => trades.filter(t => t.R > b.min && t.R <= b.max).length);
  const max = Math.max(...counts, 1);
  const avg = trades.reduce((s, t) => s + t.R, 0) / trades.length;
  return (
    <div className="mn-hist">
      {buckets.map((b, i) => (
        <div key={i} className="mn-hc">
          <div className="mn-hv">{counts[i]}</div>
          <div className="mn-hbar-wrap">
            <div className={`mn-hbar ${i < 3 ? 'down' : 'up'}`} style={{ height: `${(counts[i] / max) * 100}%` }} />
          </div>
          <div className="mn-hlbl">{b.l}</div>
        </div>
      ))}
      <div className="mn-hist-note">Average R: <b className={MF.pnlCls(avg)}>{avg.toFixed(2)}</b> · Need &gt; 0 to have an edge</div>
    </div>
  );
}

function MonoTradeCard({ t, bad = false }) {
  const q = window.qualityScore(t);
  const reason = (() => {
    if (bad) {
      if (t.planScore < 40) return 'Plan broken — no stop discipline';
      if (t.R <= -1) return 'Max defined loss — thesis invalidated';
      if (t.iv > 80) return 'Paid high IV on a short-dated call';
      if (t.horizon === 'intraday' && !t.win) return 'Intraday chase without edge';
      return 'Sizing out of proportion to edge';
    }
    if (t.R >= 2) return 'Let the winner run past 2R';
    if (t.planScore >= 85) return 'Executed plan — entry, mgmt, exit';
    if (t.strat.includes('Spread')) return 'Defined-risk premium capture';
    return 'High POP at entry · trimmed disciplined';
  })();
  return (
    <div className={`mn-trade ${bad ? 'bad' : 'good'}`}>
      <div className="mn-trade-hd">
        <div className="mn-trade-l">
          <div className="mn-trade-tkr"><b>{t.ticker}</b><span>·</span>{t.strat}</div>
          <div className="mn-trade-legs">{t.legs} · {t.entry.slice(5)} → {t.exit.slice(5)}</div>
        </div>
        <MonoQ v={q} />
      </div>
      <div className="mn-trade-reason">{reason}</div>
      <div className="mn-trade-metrics">
        <div><div className="mn-trade-l2">P&L</div><div className={`mn-trade-v ${MF.pnlCls(t.pnl)}`}>{MF.fmt$(t.pnl)}</div></div>
        <div><div className="mn-trade-l2">R</div><div className={`mn-trade-v ${MF.pnlCls(t.R)}`}>{MF.fmtR(t.R)}</div></div>
        <div><div className="mn-trade-l2">Risk</div><div className="mn-trade-v">${t.maxRisk.toLocaleString()}</div></div>
        <div><div className="mn-trade-l2">Days</div><div className="mn-trade-v">{t.daysHeld}</div></div>
        <div><div className="mn-trade-l2">Plan</div><div className="mn-trade-v">{t.planScore}</div></div>
      </div>
    </div>
  );
}

function MonoStratTable({ rows }) {
  return (
    <table className="mn-stab">
      <thead>
        <tr><th>Strategy</th><th style={{textAlign:'right'}}>Trades</th><th style={{textAlign:'right'}}>Win %</th>
          <th style={{textAlign:'right'}}>Avg R</th><th style={{textAlign:'right'}}>PF</th>
          <th style={{textAlign:'right'}}>Net P&L</th></tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const avgR = r.trades.reduce((s, t) => s + t.R, 0) / r.trades.length;
          const max = Math.max(...rows.map(x => Math.abs(x.totalPnl)));
          return (
            <tr key={r.key}>
              <td><b>{r.key}</b></td>
              <td style={{textAlign:'right'}}>{r.trades.length}</td>
              <td style={{textAlign:'right'}}>{(r.winRate * 100).toFixed(0)}%</td>
              <td style={{textAlign:'right'}} className={MF.pnlCls(avgR)}>{avgR.toFixed(2)}</td>
              <td style={{textAlign:'right'}}>{isFinite(r.pf) ? r.pf.toFixed(2) : '∞'}</td>
              <td style={{textAlign:'right'}} className={MF.pnlCls(r.totalPnl)}>
                <div className="mn-stab-bar-wrap">
                  <div className="mn-stab-bar-track">
                    {r.totalPnl >= 0
                      ? <div className="mn-stab-bar up" style={{ left: '50%', width: `${(r.totalPnl / max) * 50}%` }} />
                      : <div className="mn-stab-bar down" style={{ right: '50%', width: `${(Math.abs(r.totalPnl) / max) * 50}%` }} />}
                  </div>
                  <span>{MF.fmt$(r.totalPnl)}</span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MonoScatter({ trades }) {
  const W = 560, H = 260, pad = { l: 46, r: 14, t: 14, b: 32 };
  const xMax = Math.max(...trades.map(t => t.maxRisk)) * 1.1;
  const yMin = Math.min(-2, ...trades.map(t => t.R)) - 0.3;
  const yMax = Math.max(2, ...trades.map(t => t.R)) + 0.3;
  const x = (v) => pad.l + (Math.log10(v + 1) / Math.log10(xMax + 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mn-sc">
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="#c8c3b6" />
      {[-2, -1, 0, 1, 2, 3].map(v => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#eeece5" strokeDasharray="2 3" />
          <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fill="#999387" fontSize="10">{v}R</text>
        </g>
      ))}
      {[100, 500, 2000, 10000].map(v => v < xMax && (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={pad.t} y2={H - pad.b} stroke="#eeece5" strokeDasharray="2 3" />
          <text x={x(v)} y={H - pad.b + 14} textAnchor="middle" fill="#999387" fontSize="10">${v >= 1000 ? (v / 1000) + 'k' : v}</text>
        </g>
      ))}
      {trades.map(t => (
        <circle key={t.id} cx={x(t.maxRisk)} cy={y(t.R)} r={Math.max(4, Math.min(14, Math.sqrt(t.maxRisk / 80)))}
          fill={t.R >= 0 ? 'rgba(11,122,73,.5)' : 'rgba(179,58,58,.5)'}
          stroke={t.R >= 0 ? '#0b7a49' : '#b33a3a'} strokeWidth=".8">
          <title>{t.ticker} {t.strat} · {MF.fmtR(t.R)} · ${t.maxRisk}</title>
        </circle>
      ))}
      <text x={W / 2} y={H - 4} textAnchor="middle" fill="#999387" fontSize="10">Max risk · log scale</text>
    </svg>
  );
}

function MonoQ({ v }) {
  const grade = v >= 85 ? 'A' : v >= 70 ? 'B' : v >= 55 ? 'C' : v >= 40 ? 'D' : 'F';
  const cls = v >= 70 ? 'up' : v >= 55 ? 'flat' : 'down';
  return <span className={`mn-q ${cls}`}><b>{grade}</b><span>{v}</span></span>;
}

function MonoTags({ t, compact }) {
  const tags = [];
  if (t.R >= 2) tags.push('runner');
  if (t.R <= -1) tags.push('max-loss');
  if (t.planScore < 50) tags.push('broke-plan');
  if (t.iv > 80) tags.push('hi-IV');
  if (t.maxRisk > 1500) tags.push('oversized');
  if (t.horizon === 'intraday' && !t.win) tags.push('chase');
  if (tags.length === 0) tags.push('clean');
  return (
    <div className="mn-tags">
      {tags.slice(0, compact ? 2 : 99).map(x => <span key={x} className={`mn-tag ${x === 'clean' || x === 'runner' ? 'up' : (x === 'max-loss' || x === 'broke-plan' || x === 'chase' ? 'down' : 'flat')}`}>{x}</span>)}
    </div>
  );
}

window.MonoDashboard = MonoDashboard;
