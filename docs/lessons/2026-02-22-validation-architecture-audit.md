Problem
CLAUDE.md says validate at the boundary, not in orchestration. The codebase does not follow
this. Five-agent investigation found ~35% of code paths protected by Zod; the other 65% use
TypeScript generics (compile-time only), ad-hoc throws, or nothing. The pattern everywhere is:
data enters without .parse() → cast to assumed type with `as` → used downstream without checks.

Decision
Produce a rearchitecture document (docs/validation-rearchitecture.md) rather than making all
changes in one pass. Six independent fix tracks identified. The single highest-leverage change
is adding parseTradeFromDb() to src/db/parse.ts — it collapses 15 separate `as` casts in
execute.ts into one boundary call, using parseLegs() and parseDirection() that already exist
but are never called by the pipeline. Security fix (path traversal in logs.ts) must be done
first in Track C.

Key Files
docs/validation-rearchitecture.md — full audit with file:line references, problem descriptions,
and the six-track roadmap. src/db/parse.ts — the right place to add parseTradeFromDb(); already
has parseLegs() and parseDirection(). src/pipeline/execute.ts — 15+ casts that parseTradeFromDb()
eliminates. src/local-api/routes/logs.ts — path traversal vulnerability (id param → path.join
with no sanitization). src/trades/record-trade.ts:315-317 — double-cast on LEG_OFF metadata
that needs a LegOffMetadataSchema. web/app/backtests/actions.ts — FormData read raw with Number()
coercion (NaN risk) and `as BacktestRunConfig` on JSON DB column.

Watch Out
Three things that look fine but aren't: (1) c.req.json<SomeType>() in Hono routes — the generic
is compile-time only, Hono does not validate at runtime; every route is unprotected. (2) The
existing parseLegs() and parseDirection() in src/db/parse.ts create a false sense of coverage —
they exist but execute.ts never calls them, so the pipeline runs on unvalidated DB rows. (3)
The `(signal as any).action` on execute.ts:599 is the most dangerous cast in the file — it
silently swallows any action value that falls through the switch, masking schema failures
upstream. Replace with `action satisfies never` for compile-time exhaustiveness.
