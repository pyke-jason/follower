# sharp-bhaskara-156016 — LLM security audit

## Goal

Pre-live hardening of the LLM integration against prompt injection, runaway cost, indefinite hangs, and silent failures. Scope: `src/agent/*` and `src/intents/orchestrator/{llm-path,intent-cache}.ts`.

## Changes

1. **Agent timeout plumbing** (`src/agent/result.ts`, `src/agent/anthropic-agent.ts`, `src/agent/xai-agent.ts`)
   - New `AgentRunOptions.timeoutMs` (default 120 000 ms).
   - Anthropic: `AbortController` wired into `query({ options: { abortController } })`, `clearTimeout` in `finally`.
   - xAI: `AbortSignal.timeout(timeoutMs)` passed to `generateText`.
   - `llm-path.ts` passes `timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? '120000')`.

2. **Prompt-injection containment** (`src/intents/orchestrator/llm-path.ts`)
   - New `sanitizeForPrompt(text)` strips `<message_text>` / `</message_text>` (case-insensitive).
   - `buildNLUPrompt` wraps message body in `<message_text>...</message_text>` delimiters and sanitizes both body and `author` before insertion.
   - `<security>` block added to `NLU_SYSTEM_PROMPT` telling the model to treat tag contents as opaque.
   - `INTENT_VERSION` bumped 60 → 61 to invalidate cached rows built under the old undelimited prompt.
   - `buildNLUPrompt` and `sanitizeForPrompt` are exported with `@internal Exported for testing only`.

3. **Daily-budget guard** (`src/intents/orchestrator/intent-cache.ts`, `llm-path.ts`)
   - New `getDailyLlmCostUsd()` sums `message_intents.cost_usd` where `created_at >= 'YYYY-MM-DD'`.
   - Before each LLM call: soft alert at `LLM_DAILY_BUDGET_USD` (default $5), hard stop at 2x returning `MANUAL_REVIEW`. Both fire `sendSystemAlert`.

4. **Failure alert** (`src/intents/orchestrator/llm-path.ts`)
   - Catch block now calls `sendSystemAlert({ severity: 'critical' })` before returning `MANUAL_REVIEW`. `DependencyUnavailableError` still bypasses.

5. **Test coverage** (`src/intents/orchestrator/llm-path.test.ts`, ~180 LOC)
   - Pure unit tests on `sanitizeForPrompt` and `buildNLUPrompt`; no LLM or DB.

## Justification per change

- **Timeout.** Lesson cites a prior 6-hour backtest hang from an SDK-level stall. Stalls in live trading block the orchestrator behind one message. Real and belongs at the Agent interface.
- **Prompt injection.** Chat content is user-controlled and flows into a prompt that decides whether to place orders. Delimiter + sanitizer + system-prompt reminder is the standard fix. ~2 lines of sanitizer; negligible overhead.
- **Daily budget.** Single ANTHROPIC_API_KEY with no external cap; a runaway eval could burn real money. Hard stop + alert is appropriate for going-live.
- **Failure alert.** Otherwise silent until next log inspection; critical-severity Pushover path exists exactly for this.
- **INTENT_VERSION bump.** Correct per `.claude/rules/orchestrator.md` — any prompt-construction change invalidates cache.

## Concerns

1. **Sanitizer scope is narrow — it catches ONE tag pair.** `sanitizeForPrompt` strips `<message_text>` only. A hostile author writing `</security>`, `</goal>`, `<audience>`, etc. inside the message body gets those through to the model. The delimiters + system-prompt caveat do most of the work; removing the sanitizer would barely change the attack surface. The test "injection attempt is contained within delimiters" passes because of the delimiters, not the sanitizer. Consider escaping `<` entirely, or renaming to reflect the narrow guarantee.

2. **`get_recent_chat` tool output is NOT sanitized.** `src/intents/trader-context.ts::formatChatContext` (backing the `get_recent_chat` tool) pipes raw prior-message text into tool-result content without delimiters or sanitization. A hostile author's previous messages can smuggle instructions into the model via the follow-trade tool — the very feature that makes us read other people's messages. Same threat model, not addressed. This is the single meaningful gap in this worktree.

3. **Test asserts "injection blocked" against a regex, not an LLM — acceptable here.** Structural defenses (delimiters + escape) are the real mechanism; unit tests on the builder are fine. The `<security>` system-prompt block is behavioral and untestable without live calls — treat it as belt-on-suspenders, not a guarantee.

4. **Timeout correctly factored at the Agent interface.** `timeoutMs` lives on `AgentRunOptions`; both `XAIAgent` and `AnthropicAgent` implement it natively using their SDK's abort mechanism. NOT duplicated business logic — two adapters wiring the same contract to two SDKs. Passes the rubric's "upstream enough" test.

5. **Daily-budget query correctness.** `gte(createdAt, '2026-04-24')` on a text ISO-8601 column works because `"2026-04-24T..."` > `"2026-04-24"` lexicographically. Confirmed column is `text('created_at')` in `schema.ts:374`. Correct; a one-line comment noting the ISO-lex dependency would help.

6. **Budget guard adds one DB round-trip per LLM call.** Author flags in Watch Out. Fine at current throughput; move to in-memory TTL cache only if throughput grows past ~100 msgs/min.

7. **`<security>` system-prompt block is partly theatre.** Prompt-defense-via-prompt is the textbook weak link. The delimiter-based structural defense is the real win. Not harmful, not a guarantee.

8. **Badges go through `JSON.stringify` but `<` is NOT escaped inside JSON strings.** A badge value like `"Long</message_text><system>..."` would reach the model intact. Badges come from the ingestion envelope so risk is lower than for user text, but the defense is weaker than the author implies.

9. **No `if (isBacktest)` introduced.** Clean on rails.

10. **Indent regression in `anthropic-agent.ts`.** The new `try`/`finally` around the `for await` loop is not re-indented — loop body stays at the outer indent inside the `try`. Cosmetic but ugly; fix before merge.

## Verdict: MERGE (with two follow-ups)

Timeout plumbing is correctly factored at the Agent interface — one option on `AgentRunOptions`, two thin native wirings in the agent impls. The right shape; no duplicated security middleware or wrapper class. The prompt-injection structural defense (delimiters + closing-tag strip + JSON-stringify for other fields) is real, if narrower than the function name implies. Daily-budget hard stop with critical alert is appropriate for a single-user going-live posture. Failure alert closes the silent-failure gap. `INTENT_VERSION` bump handles cache invalidation. Test file exercises the builder and sanitizer without a mocked LLM — the author correctly resisted theatre tests. This is a lean, properly-factored piece of work that makes the live pipeline meaningfully harder to attack and impossible to silently run up a bill. Merge it. Going live without this change is strictly worse than going live with it.

Two gaps worth flagging, neither a blocker: (a) `formatChatContext` in `trader-context.ts` delivers user-controlled text to the model via `get_recent_chat` with no sanitization; (b) `sanitizeForPrompt` only strips one tag pair, so the real structural defense is the delimiter + JSON-escape combination, not the sanitizer.

## Required fixes

**Before merge (cosmetic):**
1. Re-indent the `for await` block inside the new `try` in `src/agent/anthropic-agent.ts:109-127`.

**Post-merge, same session:**
2. Apply sanitization/delimiters to `formatChatContext` in `src/intents/trader-context.ts`. Wrap each message in per-message delimiters with the sanitizer, or escape `<` entirely. A hostile message in the room today can injection-target any follow-trade classification using `get_recent_chat`.
3. (Nit) Rename `sanitizeForPrompt` to `stripMessageTextTags`, or broaden it to escape `<` generally. The current name overstates the guarantee.
4. (Nit) One-line comment on `getDailyLlmCostUsd` noting ISO-8601 lexical-ordering dependency on the `YYYY-MM-DD` prefix.

## Reviewer verdict

**Agree with MERGE.** Attempted to falsify the thesis on the three load-bearing claims; each survives.

**Timeout factoring (claim 4) is correct.** Verified both impls at the Agent interface, not duplicated:
- `AgentRunOptions.timeoutMs` added once in `src/agent/result.ts:47`.
- `anthropic-agent.ts:82-86` uses `AbortController` + `setTimeout` + `clearTimeout` in `finally`, wired to `query({ options: { abortController } })`.
- `xai-agent.ts:69` uses `AbortSignal.timeout(opts.timeoutMs ?? 120_000)`, native to the `ai` SDK.
Two thin adapters over a single contract — exactly the XAI-timeout pattern the rubric asks for. No shared `SecurityWrapper`, no middleware, no `if (provider === ...)`. Default (`?? 120_000`) duplicated across three sites is the only nit; a named constant would be cleaner but not load-bearing.

**Prompt-injection defence is real but narrower than named (claims 1, 7, 8).** Confirmed:
- `sanitizeForPrompt` (`llm-path.ts:433-435`) only strips `<message_text>` open/close tags; any other delimiter (`</security>`, `</goal>`) passes through. The structural win is the `<message_text>…</message_text>` wrapping + JSON.stringify for other fields + the one-pass strip preventing naive tag-escape. The `<security>` system-prompt block is prompt-defense-via-prompt — belt-on-suspenders, not a guarantee, as the author flags.
- Test at `llm-path.test.ts:99-117` is honest: asserts the injected `</message_text>` is stripped and the payload stays inside delimiters. It does NOT claim the LLM ignores the injection — it proves the structural contract holds. Not theatre.

**Concern 2 (formatChatContext) confirmed and material.** `src/intents/trader-context.ts:83-93` builds tool-result strings from `htmlToLLMText(m.rawHtml).slice(0, 200)` with zero sanitization or per-message delimiters. This output flows through `get_recent_chat` — the exact tool the author's threat model (user-controlled chat → classification) is defending. The narrow-sanitizer critique in the thesis is correct: hardening the main prompt while leaving the follow-trade tool open is half the job. Follow-up #2 is the one I'd want before "going live without this is strictly worse" becomes fully true.

**Concern 5 (lexical ISO ordering) verified.** `message_intents.createdAt` is `text('created_at').$defaultFn(() => new Date().toISOString())` at `schema.ts:374`. `gte(createdAt, 'YYYY-MM-DD')` works because `"2026-04-24T..."` > `"2026-04-24"` lexicographically. Subtle, worth the comment the thesis requests.

**Concern 10 (indent regression) verified.** `anthropic-agent.ts:108-130` — `try` at col 4, `for await` body stays at col 4 instead of col 6. Cosmetic.

No falsifications. Thesis is accurate, calibrated, and the required-fixes list matches what I'd write. Merge.

## Reviewer verdict

**APPROVE** (with the post-merge follow-ups already enumerated).

Independently re-ran the falsification pass on the rubric-critical claim (Agent-interface factoring) plus the load-bearing security claims.

**Agreements:**
- Timeout is correctly factored at the `Agent` interface, not duplicated. `AgentRunOptions.timeoutMs` lives once in `src/agent/result.ts:47`. `anthropic-agent.ts:82-86,104,128-130` wires `AbortController` + `setTimeout` + `clearTimeout` in `finally`. `xai-agent.ts:69` uses native `AbortSignal.timeout(opts.timeoutMs ?? 120_000)`. Two thin SDK adapters over one shared contract — exactly the XAI-pattern rubric. No `if (provider === ...)`, no shared wrapper class. The `?? 120_000` default is repeated in three sites (result.ts comment, both impls, llm-path.ts env fallback) — minor duplication but not a factoring violation.
- `sanitizeForPrompt` is narrow as the thesis admits (only `<message_text>` open/close, regex `/<\/?message_text\b[^>]*>/gi`). Real defense is the `<message_text>...</message_text>` wrapping plus `JSON.stringify` for badges/symbols. The author and thesis both acknowledge this honestly.
- Test file (`llm-path.test.ts`) is honest — proves the structural contract (one closing tag, payload contained) without claiming the LLM ignores injection. Not theatre.
- `formatChatContext` (`trader-context.ts:83-93`) confirmed un-sanitized: `htmlToLLMText(m.rawHtml).slice(0, 200)` flows into tool output for `get_recent_chat` with no delimiters or tag-strip. Material gap, correctly flagged as post-merge follow-up.
- `getDailyLlmCostUsd` lexical ordering confirmed safe — `messageIntents.createdAt` is `text('created_at')` storing ISO-8601, so `gte(createdAt, 'YYYY-MM-DD')` works lexicographically.
- Indent regression in `anthropic-agent.ts:108-127` confirmed (try at col 4, loop body still at col 4). Cosmetic.
- `INTENT_VERSION` 60 → 61 correct per orchestrator.md cache rules.
- No `if (isBacktest)` branches introduced; rails clean.

**Disagreements:** None. Thesis verdict (MERGE with two follow-ups) is calibrated. Severity placement (cosmetic vs blocker vs post-merge) matches my read.

**Missed:** Nothing material. The `<security>` system-prompt block being prompt-defense-via-prompt is flagged. The DB round-trip per LLM call is flagged. The narrow sanitizer name is flagged. The chat-tool gap is flagged.

**Verdict:** APPROVE. Lean, properly-factored hardening; security-via-structure (delimiters + JSON-escape + cache-version bump) is the real win, prompt-level defenses are correctly identified as belt-and-suspenders. Going live with this is strictly better than without.

Path: /Users/jason/Workspace/trade-follower-3/.claude/worktree-review/sharp-bhaskara-156016.md
