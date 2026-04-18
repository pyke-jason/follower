---
paths: src/agent/**, src/intents/intent-tools.ts, src/intents/orchestrator/llm-path.ts
---

# Agent Tool Schemas

## Zod is the single source of truth for tool inputs

Both provider SDKs accept Zod directly — never introduce a JSON-Schema intermediate or a JSON-to-Zod converter.

- `@anthropic-ai/claude-agent-sdk`'s `tool(name, desc, shape, handler)` takes an `AnyZodRawShape` — the `Record<string, ZodTypeAny>` you get from `z.object({...}).shape`.
- `ai` package's `dynamicTool({ inputSchema })` accepts any `FlexibleSchema`, which includes Zod v3 and v4 schemas directly (no `jsonSchema()` wrapper).

`ToolDef` in `src/agent/tool-factory.ts` carries a `z.ZodObject`. The Anthropic adapter reads `.shape`; the xAI adapter passes the object straight to `dynamicTool`. A previous revision hand-wrote JSON Schema in tool builders and ran a JSON→Zod converter at the Anthropic boundary; that dropped refines, `nullable().default()`, `min(1)`, and branded number types (`zPrice`, `zPct01`) silently. Do not reintroduce that pattern.

## Split refined schemas into `Object` (bare) + `Schema` (refined)

A `z.object(...).refine(...)` is a `ZodEffects`, which has no `.shape` property. When a schema needs both a refine rule AND `.shape` access for a tool signature, define the bare object first, then refine — export both from `src/agent/schemas.ts`:

```ts
export const SignalObject = z.object({ ...fields });             // for tool signatures / .shape
export const SignalSchema = SignalObject.refine(...);            // for runtime .parse()
```

The tool builder references the `Object` version; runtime validators (`intentOnToolCall`, `execute`) reference the refined `Schema` version. Refines do not survive JSON Schema conversion inside either SDK, so the model never sees them — cross-field invariants communicated to the model must live in `.describe(...)` strings on the fields.

## Add `.describe(...)` to every Zod field the model sees

The SDKs serialize Zod to JSON Schema using each field's `.describe(...)` as the `description`. When adding a field to a tool-input schema, put the hint the model needs on the Zod field itself — not in a parallel JSON Schema document, not in a comment. If a hint is missing, the model loses context.
