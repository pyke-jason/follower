Problem
Production classification needed alert-only LLM budget handling, deterministic pre-trade blocking for obvious execution mismatches, and postmortem visibility on every settled decision without adding more ad hoc JSON shape checks.

Decision
Add Zod-first safety contracts in `src/safety/schemas.ts`, parse gate and audit payloads at the boundary, and derive TypeScript types from those schemas. The pre-trade gate judges the resolved execution payload, while raw classifier output stays as audit evidence. Postmortem summary fields are produced by a Zod summary schema instead of scattered nullish fallbacks.

Key Files
`src/safety/classification-gate.ts`
`src/safety/classification-audit.ts`
`src/safety/classification-critic.ts`
`src/safety/schemas.ts`
`src/pipeline/process-task.ts`
`src/local-api/routes/audits.ts`
`web/src/views/audits/page.tsx`

Watch Out
The safety schema file is imported by the frontend through `@src/local-api/http-schemas`, so it must not use backend-only `@/` aliases. Keep cross-boundary schemas relative or otherwise resolvable from both TypeScript projects.
