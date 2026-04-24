// Realistic mock trade data for a day/swing trader
// Mix: long calls, long puts, verticals, calendars, CSP/CC, shares
// Each trade has: entry/exit, capital, maxRisk, pnl, days held, IV, POP

const RAW_TRADES = [
  // Winners — clean
  { id: 'T-0412', ticker: 'NVDA', strat: 'Long Call',       legs: '525C 4/19',        entry: '2026-04-02', exit: '2026-04-09', dte: 17, capital: 1840, maxRisk: 1840, pnl: 3120, planScore: 92, iv: 68, pop: 42, delta: 0.52, horizon: 'swing', notes: 'AI capex tailwind; broke ATH on volume' },
  { id: 'T-0411', ticker: 'SPY',  strat: 'Bull Put Spread', legs: '515/510P 4/12',    entry: '2026-04-01', exit: '2026-04-05', dte: 11, capital: 285,  maxRisk: 285,  pnl: 215,  planScore: 88, iv: 14, pop: 78, delta: 0.22, horizon: 'swing', notes: 'Held to 85% max — disciplined' },
  { id: 'T-0410', ticker: 'AAPL', strat: 'CSP',             legs: '170P 4/19',        entry: '2026-03-28', exit: '2026-04-12', dte: 22, capital: 17000, maxRisk: 16830, pnl: 170, planScore: 85, iv: 22, pop: 84, delta: 0.18, horizon: 'position', notes: 'Wheeled on dip; collected full premium' },
  { id: 'T-0409', ticker: 'TSLA', strat: 'Bear Call Spread', legs: '260/265C 4/12',   entry: '2026-04-02', exit: '2026-04-08', dte: 10, capital: 320,  maxRisk: 320,  pnl: 180,  planScore: 81, iv: 54, pop: 68, delta: -0.28, horizon: 'swing', notes: '' },
  { id: 'T-0408', ticker: 'META', strat: 'Long Call',       legs: '520C 4/26',        entry: '2026-03-26', exit: '2026-04-04', dte: 31, capital: 1220, maxRisk: 1220, pnl: 1580, planScore: 76, iv: 31, pop: 44, delta: 0.55, horizon: 'swing', notes: '' },
  { id: 'T-0407', ticker: 'AMD',  strat: 'Calendar',        legs: '165C 4/12/4/26',   entry: '2026-03-24', exit: '2026-04-10', dte: 33, capital: 420,  maxRisk: 420,  pnl: 290,  planScore: 79, iv: 49, pop: 52, delta: 0.04, horizon: 'position', notes: 'IV crush played out' },
  { id: 'T-0406', ticker: 'QQQ',  strat: 'Bull Call Spread', legs: '440/445C 4/19',   entry: '2026-04-05', exit: '2026-04-11', dte: 14, capital: 240,  maxRisk: 240,  pnl: 160,  planScore: 84, iv: 17, pop: 58, delta: 0.38, horizon: 'swing', notes: '' },

  // Losers — various flavors
  { id: 'T-0405', ticker: 'COIN', strat: 'Long Call',       legs: '255C 4/12',        entry: '2026-04-03', exit: '2026-04-08', dte: 9,  capital: 780,  maxRisk: 780,  pnl: -520, planScore: 42, iv: 92, pop: 38, delta: 0.48, horizon: 'swing', notes: 'Chased; IV crush next morning' },
  { id: 'T-0404', ticker: 'NFLX', strat: 'Long Put',        legs: '590P 4/19',        entry: '2026-04-01', exit: '2026-04-04', dte: 18, capital: 910,  maxRisk: 910,  pnl: -640, planScore: 38, iv: 44, pop: 36, delta: -0.44, horizon: 'swing', notes: 'Bearish thesis broken on gap' },
  { id: 'T-0403', ticker: 'GME',  strat: 'Long Call',       legs: '22C 4/12',         entry: '2026-04-02', exit: '2026-04-03', dte: 10, capital: 340,  maxRisk: 340,  pnl: -280, planScore: 25, iv: 148, pop: 29, delta: 0.46, horizon: 'intraday', notes: 'YOLO — no plan' },
  { id: 'T-0402', ticker: 'AMZN', strat: 'Bull Put Spread', legs: '180/175P 4/19',    entry: '2026-03-29', exit: '2026-04-10', dte: 21, capital: 265,  maxRisk: 265,  pnl: -235, planScore: 55, iv: 26, pop: 72, delta: 0.24, horizon: 'swing', notes: 'Held through break; should have closed at 2x' },
  { id: 'T-0401', ticker: 'ARKK', strat: 'Long Call',       legs: '52C 4/19',         entry: '2026-04-04', exit: '2026-04-09', dte: 15, capital: 185,  maxRisk: 185,  pnl: -120, planScore: 48, iv: 58, pop: 40, delta: 0.42, horizon: 'swing', notes: '' },
  { id: 'T-0400', ticker: 'NVDA', strat: 'Long Put',        legs: '480P 4/5',         entry: '2026-04-01', exit: '2026-04-02', dte: 4,  capital: 520,  maxRisk: 520,  pnl: -390, planScore: 18, iv: 72, pop: 31, delta: -0.38, horizon: 'intraday', notes: 'Fought the trend' },

  // Earlier history — a few more winners + losers to make curves interesting
  { id: 'T-0399', ticker: 'MSFT', strat: 'Long Call',       legs: '420C 3/28',        entry: '2026-03-18', exit: '2026-03-25', dte: 10, capital: 820,  maxRisk: 820,  pnl: 640,  planScore: 82, iv: 23, pop: 48, delta: 0.51, horizon: 'swing', notes: '' },
  { id: 'T-0398', ticker: 'GOOGL', strat: 'Bull Call Spread', legs: '155/160C 3/28',  entry: '2026-03-17', exit: '2026-03-27', dte: 11, capital: 220,  maxRisk: 220,  pnl: 180,  planScore: 88, iv: 21, pop: 54, delta: 0.36, horizon: 'swing', notes: '' },
  { id: 'T-0397', ticker: 'SPY',  strat: 'Iron Condor',     legs: '510/515 / 525/530', entry: '2026-03-15', exit: '2026-03-26', dte: 14, capital: 325, maxRisk: 325,  pnl: 240,  planScore: 86, iv: 15, pop: 74, delta: 0.02, horizon: 'swing', notes: '' },
  { id: 'T-0396', ticker: 'TSLA', strat: 'Long Call',       legs: '240C 3/22',        entry: '2026-03-12', exit: '2026-03-19', dte: 10, capital: 640,  maxRisk: 640,  pnl: -410, planScore: 44, iv: 58, pop: 40, delta: 0.49, horizon: 'swing', notes: 'Wrong on catalyst' },
  { id: 'T-0395', ticker: 'SMCI', strat: 'Long Call',       legs: '850C 3/22',        entry: '2026-03-10', exit: '2026-03-14', dte: 12, capital: 1250, maxRisk: 1250, pnl: 1820, planScore: 74, iv: 88, pop: 36, delta: 0.52, horizon: 'swing', notes: 'Momentum trade' },
  { id: 'T-0394', ticker: 'PLTR', strat: 'CSP',             legs: '22P 3/28',         entry: '2026-03-08', exit: '2026-03-26', dte: 20, capital: 2200, maxRisk: 2156, pnl: 44,   planScore: 80, iv: 62, pop: 82, delta: 0.17, horizon: 'position', notes: '' },
  { id: 'T-0393', ticker: 'QQQ',  strat: 'Long Put',        legs: '430P 3/14',        entry: '2026-03-05', exit: '2026-03-07', dte: 9,  capital: 280,  maxRisk: 280,  pnl: 310,  planScore: 72, iv: 19, pop: 42, delta: -0.42, horizon: 'intraday', notes: '' },
  { id: 'T-0392', ticker: 'COIN', strat: 'Long Call',       legs: '240C 3/14',        entry: '2026-03-04', exit: '2026-03-06', dte: 10, capital: 520,  maxRisk: 520,  pnl: -390, planScore: 32, iv: 94, pop: 38, delta: 0.47, horizon: 'swing', notes: 'Chased, again' },
  { id: 'T-0391', ticker: 'AAPL', strat: 'Covered Call',    legs: '175C 3/21',        entry: '2026-03-01', exit: '2026-03-20', dte: 20, capital: 17500, maxRisk: 17500, pnl: 210, planScore: 90, iv: 19, pop: 76, delta: -0.22, horizon: 'position', notes: '' },
  { id: 'T-0390', ticker: 'NVDA', strat: 'Calendar',        legs: '500C 3/14/3/28',   entry: '2026-02-28', exit: '2026-03-14', dte: 28, capital: 540,  maxRisk: 540,  pnl: 380,  planScore: 81, iv: 65, pop: 50, delta: 0.03, horizon: 'position', notes: '' },
  { id: 'T-0389', ticker: 'HOOD', strat: 'Long Call',       legs: '21C 3/14',         entry: '2026-03-02', exit: '2026-03-05', dte: 12, capital: 195,  maxRisk: 195,  pnl: -150, planScore: 28, iv: 78, pop: 34, delta: 0.44, horizon: 'swing', notes: 'FOMO' },
  { id: 'T-0388', ticker: 'MSTR', strat: 'Bear Call Spread', legs: '1700/1720C 3/14', entry: '2026-03-01', exit: '2026-03-13', dte: 13, capital: 850,  maxRisk: 850,  pnl: 520,  planScore: 78, iv: 102, pop: 64, delta: -0.26, horizon: 'swing', notes: '' },
  { id: 'T-0387', ticker: 'SPY',  strat: 'Bull Put Spread', legs: '505/500P 3/14',    entry: '2026-02-27', exit: '2026-03-12', dte: 15, capital: 215,  maxRisk: 215,  pnl: 175,  planScore: 87, iv: 13, pop: 80, delta: 0.2, horizon: 'swing', notes: '' },
  { id: 'T-0386', ticker: 'BABA', strat: 'Long Call',       legs: '80C 3/14',         entry: '2026-02-26', exit: '2026-03-04', dte: 16, capital: 420,  maxRisk: 420,  pnl: -310, planScore: 40, iv: 46, pop: 40, delta: 0.41, horizon: 'swing', notes: '' },
  { id: 'T-0385', ticker: 'DIS',  strat: 'Long Call',       legs: '110C 3/21',        entry: '2026-02-25', exit: '2026-03-06', dte: 24, capital: 310,  maxRisk: 310,  pnl: 220,  planScore: 70, iv: 28, pop: 46, delta: 0.50, horizon: 'swing', notes: '' },
  { id: 'T-0384', ticker: 'AMD',  strat: 'Long Call',       legs: '170C 3/7',         entry: '2026-02-20', exit: '2026-02-26', dte: 15, capital: 680,  maxRisk: 680,  pnl: 920,  planScore: 72, iv: 54, pop: 44, delta: 0.53, horizon: 'swing', notes: '' },
  { id: 'T-0383', ticker: 'TLT',  strat: 'Shares',          legs: '200 sh',           entry: '2026-02-14', exit: '2026-03-18', dte: null, capital: 18200, maxRisk: 910, pnl: -280, planScore: 60, iv: null, pop: null, delta: 1, horizon: 'position', notes: 'Rate hedge' },
  { id: 'T-0382', ticker: 'NVDA', strat: 'Shares',          legs: '50 sh',            entry: '2026-02-10', exit: '2026-04-15', dte: null, capital: 24500, maxRisk: 2450, pnl: 1850, planScore: 78, iv: null, pop: null, delta: 1, horizon: 'position', notes: '' },
];

// Derived fields for each trade
const TRADES_BASE = RAW_TRADES.map((t) => {
  const entryD = new Date(t.entry);
  const exitD = new Date(t.exit);
  const daysHeld = Math.max(1, Math.round((exitD - entryD) / 86400000));
  const returnPct = (t.pnl / t.maxRisk) * 100;
  const R = t.pnl / t.maxRisk; // simple R-multiple on defined risk
  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][entryD.getDay()];
  return { ...t, daysHeld, returnPct, R, dayOfWeek, entryDate: entryD, exitDate: exitD, win: t.pnl > 0 };
}).sort((a, b) => a.exitDate - b.exitDate);

// ── Repo-style enrichments ──────────────────────────────────────────
// Flag set matches web/src/components/trades-table-client.tsx + schema:
//   autoClose, legOff, trim, add, slippage, closeFailed, marketDataFail,
//   chaseWarn, chaseDanger, hasUpdate
// Strategy color key maps to --strategy-{cds,pds,call,put,stock,ccs,pcs}
function stratColorKey(s) {
  if (/Bull Put|Put Credit/.test(s)) return 'pcs';   // fuchsia
  if (/Bear Call|Call Credit/.test(s)) return 'ccs'; // teal
  if (/Bull Call|Call Debit/.test(s)) return 'cds';  // amber
  if (/Bear Put|Put Debit/.test(s)) return 'pds';    // violet
  if (/Long Call/.test(s)) return 'call';            // emerald
  if (/Long Put/.test(s)) return 'put';              // rose
  if (/Shares/.test(s)) return 'stock';              // sky
  if (/Iron Condor|Calendar/.test(s)) return 'pds';
  if (/CSP|Covered/.test(s)) return 'stock';
  return 'stock';
}

// Deterministic pseudo-hash so flags + traders are stable per trade id
function h(s, mod) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
  return n % mod;
}

// ── Traders ────────────────────────────────────────────────────────
// These are the ACTUAL human discretionary traders we follow.
// Our driver code ("the bot") copies their trades into our account —
// the traders themselves aren't separate entities from a book perspective.
const TRADER_ROSTER = [
  { handle: '@izzytrader',    name: 'Izzytrader',    since: '2023-06-01' },
  { handle: '@davew',         name: 'Dave W',        since: '2024-01-12' },
  { handle: '@brianh',        name: 'Brian H',       since: '2024-03-04' },
  { handle: '@ali_o',         name: 'ali_o',         since: '2023-11-22' },
  { handle: '@kaiboscowboy',  name: 'KaibosCowboy',  since: '2024-05-20' },
  { handle: '@pete',          name: 'Pete',          since: '2024-09-14' },
  { handle: '@ndrick',        name: 'ndRick',        since: '2025-01-08' },
  { handle: '@sappur',        name: 'Sappur',        since: '2024-08-02' },
];
const TRADERS = TRADER_ROSTER.map(t => t.handle);

// Realistic "market hours" entry/exit times with signal→fill latency.
// Market open 09:30 ET, close 16:00 ET.
function marketTime(entryDate, trade) {
  const d = new Date(entryDate);
  // Hour of day 9-15, minute 0-59
  const hour = 9 + (h(trade.id + 'h', 7));   // 9..15
  const min = (h(trade.id + 'm', 60));        // 0..59
  d.setHours(hour, min, 0, 0);
  return d;
}

const TRADES = TRADES_BASE.map((t) => {
  const flags = [];
  // Chase based on high IV long premium
  if (t.iv && t.iv > 80 && /Long|Calendar/.test(t.strat)) flags.push(t.iv > 100 ? 'chaseDanger' : 'chaseWarn');
  // Auto-close on bad losses that hit intraday
  if (t.horizon === 'intraday' && t.pnl < 0) flags.push('autoClose');
  // Slippage on big winners (market moving fast)
  if (t.R > 1.5 && h(t.id, 3) === 0) flags.push('slippage');
  // Close-failed on a couple of losers
  if (t.pnl < -400 && h(t.id, 4) === 0) flags.push('closeFailed');
  // Legs off on spreads that went bad
  if (/Spread|Condor/.test(t.strat) && t.pnl < 0 && h(t.id, 3) === 1) flags.push('legOff');
  // Trimmed on big wins
  if (t.R > 1.2 && h(t.id, 3) === 2) flags.push('trim');
  // Added on position trades
  if (t.horizon === 'position' && h(t.id, 4) === 0) flags.push('add');
  // Market data fail — rare
  if (h(t.id, 14) === 0) flags.push('marketDataFail');

  // Broker vs. system reconciliation: a few trades have mismatches
  const mismatch = h(t.id, 11) === 0;
  const brokerPnl = mismatch ? Math.round(t.pnl * (1 + (h(t.id, 7) - 3) * 0.015)) : t.pnl;

  // Slippage cost (always small, shown only when slippage flag set)
  const slippage = flags.includes('slippage') ? -Math.round(Math.abs(t.pnl) * 0.04) : 0;

  // Trader attribution — deterministic across the whole book
  const traderRec = TRADER_ROSTER[h(t.id, TRADER_ROSTER.length)];
  const trader = traderRec.handle;

  // Signal / fill timestamps.
  // "signal" = when the trader we copy posted the trade.
  // "fill" = when our driver code (the "bot") mirrored it into our account.
  // Driver latency is usually 1-8s depending on load.
  const entryFill = marketTime(t.entry, t);
  const latencyEntryMs = 800 + h(t.id + 'le', 7500);    // 0.8-8.3s
  const entrySignal = new Date(entryFill.getTime() - latencyEntryMs);

  const exitFill = marketTime(t.exit, { id: t.id + 'x' });
  const latencyExitMs = 800 + h(t.id + 'lx', 7500);
  const exitSignal = new Date(exitFill.getTime() - latencyExitMs);

  // Fill quality (bps vs mid): copy-driver fills are a bit wider than manual
  const fillQualityBps = 1.5 + h(t.id + 'fq', 60) / 10;  // 1.5-7.5 bps

  // Venue
  const VENUES = ['CBOE', 'NASDAQ', 'ARCA', 'NYSE', 'ISE', 'BATS'];
  const venue = VENUES[h(t.id + 'v', VENUES.length)];

  // Number of fills (spread/multi-leg have more)
  const legCount = /Spread|Condor|Calendar/.test(t.strat) ? 2 : 1;
  const fills = legCount + (h(t.id + 'nf', 3) === 0 ? 1 : 0);

  return {
    ...t,
    flags,
    trader,
    entryFill, entrySignal, latencyEntryMs,
    exitFill, exitSignal, latencyExitMs,
    fillQualityBps,
    venue,
    fillCount: fills,
    legCount,
    stratKey: stratColorKey(t.strat),
    brokerPnl,
    reconMismatch: mismatch,
    slippage,
    chaseSteps: flags.includes('chaseDanger') ? 3 : flags.includes('chaseWarn') ? 2 : 0,
  };
});

// Summary stats
function computeStats(trades) {
  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalRisk = trades.reduce((s, t) => s + t.maxRisk, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const bestTrade = trades.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null);
  const worstTrade = trades.reduce((w, t) => (!w || t.pnl < w.pnl ? t : w), null);
  // Equity curve (cumulative by exit date)
  let cum = 0;
  const equity = trades.map(t => { cum += t.pnl; return { date: t.exitDate, cum, trade: t }; });
  // Max drawdown
  let peak = 0, maxDD = 0;
  for (const pt of equity) { peak = Math.max(peak, pt.cum); maxDD = Math.min(maxDD, pt.cum - peak); }
  // Profit factor
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  // Sharpe (simple daily)
  const rets = trades.map(t => t.R);
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(52) : 0; // weekly-ish

  return { totalPnl, totalRisk, wins: wins.length, losses: losses.length, winRate, avgWin, avgLoss, expectancy, bestTrade, worstTrade, equity, maxDD, pf, sharpe };
}

// By strategy
function groupBy(trades, key) {
  const m = {};
  for (const t of trades) {
    const k = typeof key === 'function' ? key(t) : t[key];
    (m[k] = m[k] || []).push(t);
  }
  return Object.entries(m).map(([k, v]) => ({ key: k, trades: v, ...computeStats(v) }));
}

// Quality score — composite from data only (no self-grading).
//   • R-multiple (60 pts): how much you made vs. what you risked.
//     Clipped to [-2R, +3R] so one crazy winner can't max the score.
//   • Risk-sizing (20 pts): rewards consistent sizing. Penalty grows as
//     risk exceeds ~2x your median risk.
//   • Entry IV (20 pts): rewards entering when options are cheap or at
//     fair value; penalizes paying extreme IV (>80) on long premium.
function _qualityScoreRaw(t, ctx = {}) {
  const medianRisk = ctx.medianRisk || 500;
  const r = Math.max(-2, Math.min(3, t.R));
  const rPart = ((r + 2) / 5) * 60;
  const sizeRatio = t.maxRisk / medianRisk;
  const sizePart = sizeRatio <= 1 ? 20 : Math.max(0, 20 - (sizeRatio - 1) * 8);
  let ivPart = 20;
  if (t.iv != null) {
    const isLongPremium = /Long|Calendar/.test(t.strat);
    if (isLongPremium) {
      if (t.iv < 30) ivPart = 20;
      else if (t.iv < 60) ivPart = 15;
      else if (t.iv < 80) ivPart = 8;
      else ivPart = 2;
    } else {
      // Short premium — higher IV is good
      if (t.iv > 30) ivPart = 20;
      else ivPart = 14;
    }
  }
  return Math.round(rPart + sizePart + ivPart);
}

// Helper: median risk across trades, used as sizing baseline
function medianRisk(trades) {
  const arr = trades.map(t => t.maxRisk).sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)] || 500;
}

const MEDIAN_RISK = medianRisk(TRADES);
const qScore = (t) => _qualityScoreRaw(t, { medianRisk: MEDIAN_RISK });

window.TRADES = TRADES;
window.TRADER_ROSTER = TRADER_ROSTER;
window.computeStats = computeStats;
window.groupBy = groupBy;
window.qualityScore = qScore;
window.MEDIAN_RISK = MEDIAN_RISK;

// ── Backtest run dataset ────────────────────────────────────────────
// Emulates a 1-month backtest like the repo's "Backtest Run" view:
//   - ~640 trades across 8 traders
//   - 172 still open at end of period
//   - Open positions grow linearly — part normal (CSP/CC waiting to expire,
//     options running to target), part concerning (long calls past their
//     planned exit window → close-side didn't fire)
// Deterministic via seeded hash; rebuilt client-side.

function _seed(s) { let n = 2166136261; for (let i = 0; i < s.length; i++) { n ^= s.charCodeAt(i); n = (n * 16777619) >>> 0; } return () => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; n >>>= 0; return n / 4294967296; }; }

function buildBacktest() {
  const rnd = _seed('backtest-2025-09');
  const STRATS = ['CALL', 'PUT', 'STOCK', 'CDS', 'PDS'];  // matches repo legend
  const STRAT_KEYS = { CALL: 'call', PUT: 'put', STOCK: 'stock', CDS: 'cds', PDS: 'pds' };
  const startDate = new Date('2025-09-01');
  const endDate = new Date('2025-09-30');
  const tradersPool = TRADER_ROSTER.map(t => t.handle);

  const all = [];
  let id = 10000;

  // Per-trader target total trades (realistic spread: top trader ~170, tail ~20)
  const targets = {
    '@izzytrader': 172, '@davew': 103, '@brianh': 84, '@ali_o': 71,
    '@kaiboscowboy': 57, '@pete': 62, '@ndrick': 48, '@sappur': 45,
  };

  Object.entries(targets).forEach(([handle, n]) => {
    for (let i = 0; i < n; i++) {
      // Random day in the month
      const dayOffset = Math.floor(rnd() * 30);
      const entry = new Date(startDate);
      entry.setDate(entry.getDate() + dayOffset);
      entry.setHours(9 + Math.floor(rnd() * 6), Math.floor(rnd() * 60), 0, 0);

      const stratRoll = rnd();
      let strat;
      if (stratRoll < 0.32) strat = 'CALL';
      else if (stratRoll < 0.55) strat = 'STOCK';
      else if (stratRoll < 0.72) strat = 'PUT';
      else if (stratRoll < 0.88) strat = 'CDS';
      else strat = 'PDS';

      // Hold duration — options usually 1-14d, stock longer
      const holdDays = strat === 'STOCK'
        ? 2 + Math.floor(rnd() * 20)
        : 1 + Math.floor(rnd() * 14);
      const plannedExit = new Date(entry);
      plannedExit.setDate(plannedExit.getDate() + holdDays);

      // Is this still open at end of backtest?
      // Open probability grows later in the month (that's the linear climb).
      // Also: CSP/CC legs (STOCK wheel) legitimately stay open.
      // And some long CALL/PUT "forget to close" past their planned exit.
      let isOpen = false;
      let openReason = null;
      const daysUntilEnd = (endDate - entry) / 86400000;
      if (daysUntilEnd < holdDays) {
        // Planned exit is beyond end-of-test → open, legit
        isOpen = true;
        openReason = strat === 'STOCK' ? 'holding' : 'within-window';
      } else if (strat === 'STOCK' && rnd() < 0.35) {
        // Wheel leg — CC/CSP waiting for expiry
        isOpen = true;
        openReason = 'wheel-expiry';
      } else if ((strat === 'CALL' || strat === 'PUT') && rnd() < 0.18) {
        // ⚠ Close-side didn't fire — past planned exit, still open
        isOpen = true;
        openReason = 'past-plan';
      } else if ((strat === 'CDS' || strat === 'PDS') && rnd() < 0.08) {
        isOpen = true;
        openReason = 'past-plan';
      }

      // Risk + P&L
      const maxRisk = strat === 'STOCK' ? 3000 + Math.floor(rnd() * 15000)
        : strat === 'CDS' || strat === 'PDS' ? 200 + Math.floor(rnd() * 600)
        : 300 + Math.floor(rnd() * 1800);

      // Per-trader edge — izzy is consistently positive, others mixed
      const edge = { '@izzytrader': 0.55, '@davew': 0.25, '@brianh': 0.25, '@ali_o': 0.20,
                     '@kaiboscowboy': 0.10, '@pete': 0.08, '@ndrick': 0.08, '@sappur': 0.05 }[handle];
      const win = rnd() < (0.5 + edge);

      let pnl = 0;
      let exitDate = null;
      if (!isOpen) {
        pnl = win
          ? Math.round(maxRisk * (0.15 + rnd() * 0.9))
          : -Math.round(maxRisk * (0.25 + rnd() * 0.8));
        // Commissions
        pnl -= strat === 'STOCK' ? 0 : Math.round(1 + rnd() * 3);
        exitDate = new Date(plannedExit);
      }

      // Unrealized P&L for open trades (will show as floating)
      const unrealized = isOpen
        ? Math.round((win ? 1 : -1) * maxRisk * (0.05 + rnd() * 0.4))
        : 0;

      all.push({
        id: 'BT-' + (id++),
        trader: handle,
        strat,
        stratKey: STRAT_KEYS[strat],
        entryDate: entry,
        plannedExitDate: plannedExit,
        exitDate,   // null if open
        holdDays,
        maxRisk,
        pnl,
        unrealized,
        isOpen,
        openReason,
        win,
      });
    }
  });

  // Sort by entry time so cumulative counts build correctly
  all.sort((a, b) => a.entryDate - b.entryDate);
  return all;
}

const BACKTEST_TRADES = buildBacktest();

// Run-level summary (matches header strip in repo screenshot)
function backtestMeta() {
  const all = BACKTEST_TRADES;
  const open = all.filter(t => t.isOpen);
  const closed = all.filter(t => !t.isOpen);
  const wins = closed.filter(t => t.win);
  const realizedPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const comm = closed.length * 2; // rough
  const grossPnl = realizedPnl + comm;
  const unrealized = open.reduce((s, t) => s + t.unrealized, 0);
  const wRate = closed.length ? wins.length / closed.length : 0;
  // Profit factor
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(closed.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : Infinity;
  // Max DD on cum equity curve
  let cum = 0, peak = 0, dd = 0;
  for (const t of closed) { cum += t.pnl; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return {
    tradersCount: TRADER_ROSTER.length,
    traderList: TRADER_ROSTER.map(t => t.name).join(', '),
    dateRange: '2025-09-01 — 2025-09-30',
    model: 'anthropic/claude-sonnet-4-6',
    orats: '$100K',
    comm: '$0.5/ct',
    risk: 'risk off',
    tradesTotal: all.length,
    openCount: open.length,
    winRate: wRate,
    realizedPnl,
    grossPnl,
    commissions: -comm,
    unrealizedPnl: unrealized,
    maxDD: dd,
    profitFactor: pf,
    dataSize: '19.7MB',
    runtime: '1h22m 34s',
    messages: '4,070/4,070',
    status: 'COMPLETED',
  };
}

// Build the Open Positions Timeline series (points per day)
// Returns: [{date, open, byStrat:{CALL,PUT,STOCK,CDS,PDS}, byTrader:{...}}]
function openPositionsTimeline() {
  const startDate = new Date('2025-09-01');
  const endDate = new Date('2025-09-30');
  const endReference = new Date('2026-04-07'); // show a trail that extends past backtest end (matches repo)
  const series = [];
  const days = Math.round((endReference - startDate) / 86400000);
  for (let i = 0; i <= days; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const byStrat = { CALL: 0, PUT: 0, STOCK: 0, CDS: 0, PDS: 0 };
    let open = 0;
    for (const t of BACKTEST_TRADES) {
      const entered = t.entryDate <= d;
      // Trade is "open" on day d if: entry has happened AND (still open OR exit > d)
      const exited = t.exitDate ? t.exitDate <= d : false;
      const stillOpen = entered && !exited;
      if (stillOpen) { open++; byStrat[t.strat]++; }
    }
    series.push({ date: d, open, byStrat });
  }
  return series;
}

// Diagnose the "why is this still open?" question for each open trade
function diagnoseOpenPositions() {
  const open = BACKTEST_TRADES.filter(t => t.isOpen);
  const endDate = new Date('2025-09-30');
  const categories = {
    'holding':       { label: 'Holding · stock position',    tone: 'info',  n: 0, unreal: 0, risk: 0, trades: [] },
    'wheel-expiry':  { label: 'Wheel leg · waiting on expiry', tone: 'info',  n: 0, unreal: 0, risk: 0, trades: [] },
    'within-window': { label: 'Within planned window',       tone: 'info',  n: 0, unreal: 0, risk: 0, trades: [] },
    'past-plan':     { label: 'Past planned exit · close-side didn\'t fire', tone: 'warn', n: 0, unreal: 0, risk: 0, trades: [] },
  };
  for (const t of open) {
    const cat = categories[t.openReason || 'within-window'];
    cat.n++; cat.unreal += t.unrealized; cat.risk += t.maxRisk; cat.trades.push(t);
  }
  return categories;
}

// Per-trader aggregates for "P&L by Trader" panel
function pnlByTrader() {
  const out = {};
  for (const t of BACKTEST_TRADES) {
    if (!out[t.trader]) out[t.trader] = { handle: t.trader, n: 0, nClosed: 0, nOpen: 0, wins: 0, pnl: 0, unreal: 0, risk: 0 };
    const o = out[t.trader];
    o.n++; o.risk += t.maxRisk;
    if (t.isOpen) { o.nOpen++; o.unreal += t.unrealized; }
    else { o.nClosed++; o.pnl += t.pnl; if (t.win) o.wins++; }
  }
  const rec = TRADER_ROSTER.reduce((m, r) => { m[r.handle] = r; return m; }, {});
  return Object.values(out).map(o => ({
    ...o,
    name: rec[o.handle]?.name || o.handle,
    winRate: o.nClosed ? o.wins / o.nClosed : 0,
  })).sort((a, b) => b.pnl - a.pnl);
}

function pnlByStrategy() {
  const out = {};
  for (const t of BACKTEST_TRADES) {
    if (!out[t.strat]) out[t.strat] = { key: t.strat, stratKey: t.stratKey, n: 0, nClosed: 0, nOpen: 0, wins: 0, pnl: 0, unreal: 0 };
    const o = out[t.strat];
    o.n++;
    if (t.isOpen) { o.nOpen++; o.unreal += t.unrealized; }
    else { o.nClosed++; o.pnl += t.pnl; if (t.win) o.wins++; }
  }
  return Object.values(out).map(o => ({
    ...o,
    winRate: o.nClosed ? o.wins / o.nClosed : 0,
  })).sort((a, b) => b.pnl - a.pnl);
}

window.BACKTEST_TRADES = BACKTEST_TRADES;
window.backtestMeta = backtestMeta;
window.openPositionsTimeline = openPositionsTimeline;
window.diagnoseOpenPositions = diagnoseOpenPositions;
window.pnlByTrader = pnlByTrader;
window.pnlByStrategy = pnlByStrategy;
