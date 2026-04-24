# Design Variations — Trade Breakdown

Source: Claude Design handoff bundle (https://api.anthropic.com/v1/design/h/ySNg1hjMvGFXrzsx6CLlfA), exported 2026-04-24.

These are mockups, not production code. Treat them as design references for the planned R-multiple/quality work and the backtest/dashboard integration deliberations. The HTML/JSX prototypes use Tailwind CDN + Recharts UMD + Babel-in-browser; do not wire them into the app — recreate the relevant pieces in our React + shadcn stack.

## Inventory

### `trade-breakdown/` — full design bundle

- `README.md` — Claude Design's "coding agents read this first" instructions
- `chats/chat1.md` — full chat transcript with the design assistant. Important context: the user explicitly removed all self-grading workflows and asked for everything to derive from trade data only. Where the intent for views 05/06 was nailed down (P&L by Trader, Open Positions Timeline + diagnosis).
- `project/Trade Breakdown.html` — the canvas host page that mounts all six artboards
- `project/trades-data.jsx` — mock book of ~30 trades with repo-style enrichments (flags, broker↔system reconciliation deltas, trader attribution, signal/fill latency, fill quality bps)
- `project/terminal-shared.jsx` — shared primitives: `KPI`, `Flags`, `Strat`, `Grade`, `RBar`, `PnL`, `EquityCurve`, `Spark`, `TradeDetailPanel`, `qualityScore`, `BotStatusPill`, latency helpers
- `project/terminal-v2.css` + `project/dashboards.css` + `project/shadcn-globals.css` — design tokens (strategy color tokens, profit/loss tokens, flag tones, density modifiers)

### Six artboard variations

| # | File | One-line | Status against our roadmap |
|---|------|----------|----------------------------|
| 01 | `project/terminal-01-command.jsx` | Bloomberg-style command center: 8-KPI strip + equity curve + reconciliation panel + blotter + inspector + R-distribution / strategy bars / day-of-week footer | Reference for any future "all-in-one operator" page |
| 02 | `project/terminal-02-split.jsx` | Left rail of ranked ticker cards (sparkline + win/loss bar) + right pane per-symbol drilldown | Possible future per-symbol view |
| 03 | `project/terminal-03-tape.jsx` | Calendar-centric: weeks vertical, weekday columns of trade chips colored by outcome + flag-frequency chart + inspector | Reference for a future calendar tab |
| 04 | `project/terminal-04-density.jsx` | Pure density: 4-column grid with 10 KPIs, equity, R-distribution, day-of-week, strategy bars, flag counts, recon, blotter (+ HOLD + TRADER), inspector — all visible without scrolling | **Direct input to the in-flight R-multiple plan** (R distribution, R column in blotter, RBar, grade column, flag counts) |
| 05 | `project/terminal-05-traders.jsx` | "Backtest Run" — KPI strip + strategy filter chips + per-trade scatter + open-positions area + ranked bars for P&L-by-trader and P&L-by-strategy | **Direct input to backtest Performance tab integration** (round 1 deliberation) |
| 06 | `project/terminal-06-bots.jsx` | "Open Positions Timeline" with diagnosis side panel categorizing each open position: holding / wheel-expiry / within-window / past-plan, with click-to-filter trade table | **Direct input to backtest diagnosis section** (round 1 deliberation, gated on `plannedExitDate`) |

### Sibling planning docs

- `r-multiple-plan.md` — the in-flight implementation plan for R-multiple + algorithmic trade quality (no manual grading). Owns risk math, `peakRisk` lifecycle preservation, quality scoring, `QualitySnapshotPanel`, and a future `/quality` page.

## Reading order for deliberation agents

1. `r-multiple-plan.md` — what's being built right now, and the constraint that nothing requires manual data entry
2. `trade-breakdown/chats/chat1.md` (skim the second half from line ~450 onward — that's where views 05/06 land)
3. `trade-breakdown/project/Trade Breakdown.html` — to see how the six variations are framed
4. `trade-breakdown/project/terminal-04-density.jsx` — the density layout, since it's the closest match to where the R-multiple work lives
5. `trade-breakdown/project/terminal-05-traders.jsx` and `terminal-06-bots.jsx` — already covered by round 1 deliberation but worth a re-read in light of the R-multiple work
6. `trade-breakdown/project/terminal-shared.jsx` — to see what the design treats as shared primitives (helps decide what we should extract)

## Open questions for the next deliberation round

- Once the R-multiple plan ships, do **Profit Factor** and **Max DD** still earn KPI-strip slots, or are they redundant with R distribution + expectancy?
- Is the Density layout (variation 04) a 4th surface, a power-user toggle on the existing Performance tab, or a `/quality` page in disguise?
- Where does the `RBar` micro-component live — extracted to a shared component, or inlined in the trade table cell?
- The Trade Detail Panel in `terminal-shared.jsx` already has Execution / Reconciliation / Timeline / Notes / Auto-tags blocks. We have an existing `TradeDetailPanel` (per `web/AGENTS.md` cookbook) — what does the design's version add that ours doesn't?
- The "auto-tags" pattern (`big-winner`, `max-loss`, `oversized · 3.5× median`, `paid high IV`, `chase`, `A-grade setup`) — does this become a real surfaced concept on trade rows, or is it cosmetic noise that hides the underlying R-multiple?
