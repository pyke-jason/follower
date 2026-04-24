/* Shared helpers + primitives for all Terminal variations.
   Exports to window so each variation JSX can pull them. */

// ── Formatting ──────────────────────────────────────────────────
const fmt$ = (n, digits = 0) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return sign + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const fmt$sign = (n, digits = 0) => (n >= 0 ? '+' : '') + fmt$(n, digits);
const fmtPct = (n, digits = 1) => (n >= 0 ? '+' : '') + n.toFixed(digits) + '%';
const fmtR = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
const fmtDate = (d) => {
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${m} ${String(d.getDate()).padStart(2,'0')}`;
};
const fmtTime = (d) => {
  let h = d.getHours(), m = d.getMinutes();
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2,'0')}${ap}`;
};
const cls = (...xs) => xs.filter(Boolean).join(' ');

// Map 0-100 score → letter grade
function grade(score) {
  if (score >= 85) return 'A';
  if (score >= 72) return 'B';
  if (score >= 58) return 'C';
  if (score >= 42) return 'D';
  return 'F';
}

// Flag icon + tone metadata
const FLAG_META = {
  autoClose:       { icon: 'AC', tone: 'muted',  title: 'Auto-closed by system' },
  legOff:          { icon: 'LO', tone: 'warn',   title: 'Leg came off separately' },
  trim:            { icon: 'TR', tone: 'muted',  title: 'Trimmed partial' },
  add:             { icon: 'AD', tone: 'muted',  title: 'Added to position' },
  slippage:        { icon: 'SL', tone: 'warn',   title: 'Slippage on fill' },
  closeFailed:     { icon: 'CF', tone: 'danger', title: 'Close order failed' },
  marketDataFail:  { icon: 'MD', tone: 'danger', title: 'Market data failure' },
  chaseWarn:       { icon: 'CH', tone: 'warn',   title: 'Chased into position' },
  chaseDanger:     { icon: 'CH', tone: 'danger', title: 'Heavy chase (3+ steps)' },
};

// ── Primitive components ────────────────────────────────────────
function Flags({ flags }) {
  if (!flags || !flags.length) return null;
  return (
    <span className="tv-flags">
      {flags.map((f, i) => {
        const m = FLAG_META[f];
        if (!m) return null;
        return <span key={i} className={`tv-flag ${m.tone}`} title={m.title}>{m.icon}</span>;
      })}
    </span>
  );
}

function Strat({ t }) {
  return <span className="tv-strat" data-k={t.stratKey}>{t.strat}</span>;
}

function Grade({ score, scale = 'A-F' }) {
  if (scale === '0-100') {
    const g = grade(score);
    return <span className={`tv-grade ${g}`}>{score}</span>;
  }
  if (scale === 'emoji') {
    const g = grade(score);
    const e = { A: '🟢', B: '🔵', C: '⚪', D: '🟡', F: '🔴' }[g];
    return <span style={{fontSize: 11}}>{e}</span>;
  }
  const g = grade(score);
  return <span className={`tv-grade ${g}`}>{g}</span>;
}

function RBar({ R }) {
  const clipped = Math.max(-2, Math.min(3, R));
  // zero line at 40% (since range is -2..+3, 2/5 = 40%)
  const pct = Math.abs(clipped) / (clipped >= 0 ? 3 : 2) * (clipped >= 0 ? 60 : 40);
  return (
    <span className="tv-rbar">
      <span className="zero" />
      <span className={`fill ${clipped >= 0 ? 'pos' : 'neg'}`} style={{ width: pct + '%' }} />
    </span>
  );
}

function PnL({ value, digits = 0, bold }) {
  const cls = value > 0 ? 'tv-pos' : value < 0 ? 'tv-neg' : 'tv-flat';
  return <span className={cls + ' tv-num'} style={bold ? {fontWeight: 600} : null}>{fmt$sign(value, digits)}</span>;
}

// ── Equity curve SVG ────────────────────────────────────────────
function EquityCurve({ trades, width = 800, height = 160, pad = 16, showArea = true, showDD = false }) {
  let cum = 0;
  const pts = [{ i: 0, v: 0, t: null }];
  trades.forEach((t, i) => { cum += t.pnl; pts.push({ i: i + 1, v: cum, t }); });
  const min = Math.min(...pts.map(p => p.v), 0);
  const max = Math.max(...pts.map(p => p.v), 0);
  const range = max - min || 1;
  const x = i => pad + (i / (pts.length - 1)) * (width - pad * 2);
  const y = v => pad + (1 - (v - min) / range) * (height - pad * 2);
  const zeroY = y(0);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const area = path + ` L ${x(pts.length - 1).toFixed(1)} ${zeroY.toFixed(1)} L ${x(0).toFixed(1)} ${zeroY.toFixed(1)} Z`;

  // Running peak for drawdown overlay
  let peak = 0;
  const ddPts = pts.map(p => { peak = Math.max(peak, p.v); return { i: p.i, dd: p.v - peak }; });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="eq-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.72 0.16 155)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="oklch(0.72 0.16 155)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Grid */}
      {[0.25, 0.5, 0.75].map(f => <line key={f} x1={pad} x2={width-pad} y1={pad + (height-pad*2)*f} y2={pad + (height-pad*2)*f} stroke="oklch(0.25 0 0)" strokeDasharray="2 3" />)}
      {/* Zero baseline */}
      <line x1={pad} x2={width-pad} y1={zeroY} y2={zeroY} stroke="oklch(0.4 0 0)" strokeDasharray="3 3" />
      {showArea && <path d={area} fill="url(#eq-grad)" />}
      <path d={path} fill="none" stroke="oklch(0.82 0.2 155)" strokeWidth="1.5" />
      {/* End marker */}
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length-1].v)} r="3" fill="oklch(0.82 0.2 155)" />
      {/* Peak/worst annotations */}
      {pts.map((p, i) => i > 0 && (p.v === max || p.v === min) && (
        <g key={i}>
          <circle cx={x(p.i)} cy={y(p.v)} r="2" fill={p.v === max ? 'oklch(0.82 0.2 155)' : 'oklch(0.80 0.22 25)'} />
        </g>
      ))}
    </svg>
  );
}

// ── Sparkline ───────────────────────────────────────────────────
function Spark({ values, width = 60, height = 18, color = 'oklch(0.82 0.2 155)' }) {
  if (!values.length) return null;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const x = i => (i / (values.length - 1)) * width;
  const y = v => height - ((v - min) / range) * height;
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} className="tv-spark">
      <line x1="0" x2={width} y1={y(0)} y2={y(0)} stroke="oklch(0.35 0 0)" strokeDasharray="1 2" />
      <path d={path} fill="none" stroke={color} strokeWidth="1" />
    </svg>
  );
}

// ── Latency helpers ─────────────────────────────────────────────
// "Latency" here = driver-copy latency: time between the followed
// trader posting a trade and our driver code mirroring it in our account.
// Target: < 3s is good, 3-8s warn, > 8s bad.
function fmtLatency(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
}
function latencyTone(ms) {
  if (ms < 3000) return 'tv-pos';
  if (ms < 8000) return 'tv-warn';
  return 'tv-neg';
}

// ── TradeDetailPanel ────────────────────────────────────────────
// Richer drawer modeled on the repo's trade detail UI.
// Replaces the older Inspector component in all variations.
function TradeDetailPanel({ t, showQuality = true, gradeScale = 'A-F', compact = false }) {
  if (!t) return <div style={{ padding: 14, color: 'var(--term-muted)' }}>Select a trade.</div>;

  const q = qualityScore(t);
  const sizeRatio = t.maxRisk / window.MEDIAN_RISK;
  const entryLat = t.latencyEntryMs;
  const exitLat = t.latencyExitMs;

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

  // Timeline events — signal = trader we copy posted; fill = driver mirrored into our account
  const events = [
    { t: t.entrySignal, kind: 'sig',  label: 'Entry signal posted',  sub: `by ${t.trader}` },
    { t: t.entryFill,   kind: 'fill', label: `Driver copied · ${t.fillCount} fill${t.fillCount>1?'s':''}`, sub: `${t.venue} · ${t.fillQualityBps.toFixed(1)} bps vs mid · copy lag ${fmtLatency(entryLat)}` },
    ...(t.flags.includes('trim') ? [{ t: new Date((+t.entryFill + +t.exitFill) / 2), kind: 'trim', label: 'Trimmed 50%', sub: 'partial scale-out' }] : []),
    ...(t.flags.includes('add') ? [{ t: new Date((+t.entryFill + +t.exitFill) / 2), kind: 'add', label: 'Added to position', sub: 'size doubled' }] : []),
    ...(t.flags.includes('legOff') ? [{ t: new Date(+t.exitFill - 3600000), kind: 'warn', label: 'Leg came off', sub: 'spread partial close' }] : []),
    ...(t.flags.includes('closeFailed') ? [{ t: new Date(+t.exitFill - 600000), kind: 'err', label: 'Close order failed', sub: 'broker rejected · retried' }] : []),
    { t: t.exitSignal, kind: 'sig',  label: 'Exit signal posted',  sub: t.flags.includes('autoClose') ? 'system auto-close' : `by ${t.trader}` },
    { t: t.exitFill,   kind: 'fill', label: 'Driver copied exit',   sub: `${t.venue} · copy lag ${fmtLatency(exitLat)}` },
  ].sort((a, b) => a.t - b.t);

  return (
    <div className="tv-tdp" style={{ '--swatch': `var(--s-${t.stratKey})` }}>
      {/* Header: ticker, strat, P&L */}
      <div className="tdp-hd">
        <div>
          <div className="tdp-tkr">
            {t.ticker} <span className="tdp-strat"><Strat t={t} /></span>
          </div>
          <div className="tdp-legs">{t.legs}</div>
        </div>
        <div className="tdp-pnl-box">
          <div className={`tdp-pnl ${t.pnl >= 0 ? 'tv-pos' : 'tv-neg'}`}>{fmt$sign(t.pnl)}</div>
          <div className={`tdp-r ${t.R >= 0 ? 'tv-pos' : 'tv-neg'}`}>{fmtR(t.R)} · {fmtPct(t.returnPct)}</div>
        </div>
      </div>

      {/* Badge row: flags, trader, quality */}
      <div className="tdp-badges">
        <span className="tdp-who">copied from <b style={{color:'var(--term-fg-2)'}}>{t.trader}</b></span>
        <Flags flags={t.flags} />
        <span className="tdp-push" />
        {showQuality && <span className="tdp-qwrap"><Grade score={q} scale={gradeScale} /> <span className="tdp-qn">{q}/100</span></span>}
      </div>

      {/* Key facts grid */}
      <div className="tdp-grid">
        <div><div className="k">Max risk</div><div className="v">{fmt$(t.maxRisk)}</div></div>
        <div><div className="k">Size / median</div><div className="v">{sizeRatio.toFixed(2)}×</div></div>
        <div><div className="k">Held</div><div className="v">{t.daysHeld}d · {t.horizon}</div></div>
        <div><div className="k">Entry IV</div><div className="v">{t.iv != null ? t.iv + '%' : '—'}</div></div>
        <div><div className="k">POP</div><div className="v">{t.pop != null ? t.pop + '%' : '—'}</div></div>
        <div><div className="k">Δ at entry</div><div className="v">{t.delta != null ? t.delta.toFixed(2) : '—'}</div></div>
        <div><div className="k">Copied from</div><div className="v">{t.trader}</div></div>
        <div><div className="k">Venue</div><div className="v">{t.venue}</div></div>
      </div>

      {/* Execution block */}
      <div className="tdp-sect">
        <div className="tdp-sect-h">Execution</div>
        <div className="tdp-exec">
          <div className="tdp-exec-row">
            <span className="k">Entry · signal → fill</span>
            <span className={`v ${latencyTone(entryLat)}`}>{fmtLatency(entryLat)}</span>
          </div>
          <div className="tdp-exec-row">
            <span className="k">Exit · signal → fill</span>
            <span className={`v ${latencyTone(exitLat)}`}>{fmtLatency(exitLat)}</span>
          </div>
          <div className="tdp-exec-row">
            <span className="k">Fill quality (vs mid)</span>
            <span className="v">{t.fillQualityBps.toFixed(1)} bps</span>
          </div>
          <div className="tdp-exec-row">
            <span className="k">Fills</span>
            <span className="v">{t.fillCount}× · {t.legCount}-leg</span>
          </div>
          {t.slippage !== 0 && (
            <div className="tdp-exec-row">
              <span className="k">Slippage cost</span>
              <span className="v tv-warn">{fmt$(t.slippage)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Reconciliation */}
      {t.reconMismatch && (
        <div className="tdp-sect recon">
          <div className="tdp-sect-h">Reconciliation <span className="tv-warn" style={{marginLeft: 6}}>● mismatch</span></div>
          <div className="tdp-exec">
            <div className="tdp-exec-row"><span className="k">System P&L</span><span className="v">{fmt$sign(t.pnl)}</span></div>
            <div className="tdp-exec-row"><span className="k">Broker P&L</span><span className="v">{fmt$sign(t.brokerPnl)}</span></div>
            <div className="tdp-exec-row"><span className="k">Δ</span><span className="v tv-warn">{fmt$sign(t.brokerPnl - t.pnl)}</span></div>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="tdp-sect">
        <div className="tdp-sect-h">Timeline</div>
        <div className="tdp-timeline">
          {events.map((e, i) => (
            <div key={i} className={`tdp-ev ${e.kind}`}>
              <div className="tdp-ev-dot" />
              <div className="tdp-ev-body">
                <div className="tdp-ev-l">
                  <span className="tdp-ev-label">{e.label}</span>
                  <span className="tdp-ev-time">{fmtDate(e.t)} {fmtTime(e.t)}</span>
                </div>
                <div className="tdp-ev-sub">{e.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Notes */}
      {t.notes && (
        <div className="tdp-sect">
          <div className="tdp-sect-h">Notes</div>
          <div className="tdp-notes">{t.notes}</div>
        </div>
      )}

      {/* Auto tags footer */}
      <div className="tdp-tags">
        {autoTags.map((tg, i) => <span key={i} className={`tdp-tag ${tg.tone}`}>{tg.l}</span>)}
      </div>
    </div>
  );
}

Object.assign(window, {
  fmt$, fmt$sign, fmtPct, fmtR, fmtDate, fmtTime, cls, grade,
  FLAG_META, Flags, Strat, Grade, RBar, PnL, EquityCurve, Spark,
  fmtLatency, latencyTone, TradeDetailPanel,
});