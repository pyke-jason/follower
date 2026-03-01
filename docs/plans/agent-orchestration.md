# Agent Orchestration Plan

## Goal

Autonomous task execution from a single prompt — decompose a feature into small tasks, execute them in a loop with fresh context per iteration, verify mechanically, repeat.

## Architecture

```
YOU (one prompt: "build X")
  │
  ▼
ORCHESTRATOR (.claude/agents/orchestrator.md)
  │ - Decomposes goal into phases
  │ - Creates beads (bd create) with acceptance criteria
  │ - Sets dependencies (bd dep add) so phases unblock in order
  │ - Monitors progress (bd list, bd ready)
  │
  ├──▶ RALPH LOOP (scripts/ralph.sh)
  │     Runs `bd ready` each iteration to find next unblocked task
  │     Claims it (bd update --claim), implements, runs tsc + vitest
  │     Marks done (bd update --resolve), loops until no tasks remain
  │
  └──▶ GUARD RAILS (tsconfig + permissions)
        settings.local.json constrains shell commands
        Acceptance criteria on every task: "tsc passes, tests pass"
```

## Current State

| Component | Status | Location |
|---|---|---|
| CLAUDE.md coding standards | Done | `CLAUDE.md` |
| Agent definitions (3) | Done | `.claude/agents/` |
| Experimental teams flag | Done | `.claude/settings.json` |
| Strict TypeScript | Done | `tsconfig.json` (strict: true) |
| Vitest test suite | Done | `vitest.config.ts`, `npm test` |
| Permission sandbox (150+ rules) | Done | `.claude/settings.local.json` |
| Ralph loop | Done | `scripts/ralph.sh` |
| Orchestrator agent | Done | `.claude/agents/orchestrator.md` |
| Beads task tracker | Missing | `npm install -g @beads/bd` then `bd init` |
| Docker sandbox | Optional | Not needed yet |

## Files

### `scripts/ralph.sh` — The Execution Loop

A bash while-loop that restarts Claude with fresh context each iteration. Context decay is impossible because every iteration reads the task state from scratch via `bd ready`.

Each iteration:
1. `bd ready` → find next unblocked task
2. `bd show <id>` → read full description + acceptance criteria
3. `bd update <id> --claim` → mark as in-progress
4. Implement the task, following CLAUDE.md standards
5. `npx tsc --noEmit` + `npx vitest run` → verify acceptance
6. `bd update <id> --resolve` → mark done
7. Stop (next iteration picks up the next task with fresh context)

Options:
- `./scripts/ralph.sh` — run until all beads resolved
- `./scripts/ralph.sh --max-iterations 5` — cap at 5 iterations
- Logs to `.logs/ralph/<timestamp>.log`

### `.claude/agents/orchestrator.md` — The PM Brain

An agent that decomposes goals into beads. Never writes application code.

Workflow:
1. User gives a high-level goal
2. Reads CLAUDE.md, AGENTS.md, relevant source files
3. Decomposes into phases, each phase into tasks
4. Creates beads: `bd create "task title" --description "..." --acceptance "tsc passes, tests pass"`
5. Sets dependencies: `bd dep add <child> <parent>` so tasks unblock in phase order
6. Each task must be completable in one Ralph iteration (single feature, <5 files)
7. Every task's acceptance criteria must be mechanically verifiable

Rules:
- Never write code — only plan
- A task that touches more than 5 files is too big, break it down
- "Make it cleaner" is not a task. "Extract X into Y and update imports" is
- Include the specific files to read and modify in each task description

### Beads Task Tracker — `bd init`

Install globally (`npm install -g @beads/bd` or `brew install beads`), then `bd init` in the repo root. Creates a `.beads/` directory and `issues.jsonl` (the git-committed sync file).

The killer feature is `bd ready` — returns only unblocked tasks. The Ralph loop calls this each iteration instead of parsing a flat checklist. Dependencies between tasks are first-class (`bd dep add <child> <parent>`), so phase ordering is automatic.

Example: setting up the 422 retry feature as beads:

```bash
# Phase 1: Type Foundation
bd create "Add failureContext to OrchestratorContext" \
  --description "Add failureContext field to types.ts. Shape: { errorCode, occSymbol, invalidStrike, symbol, expiry, optionType }" \
  --acceptance "npx tsc --noEmit passes"
# → bd-a1b2

bd create "Add RETRY_LLM to execution outcome union" \
  --description "Add RETRY_LLM variant to outcome type in execute-resolved.ts" \
  --acceptance "npx tsc --noEmit passes, no existing tests broken"
# → bd-c3d4

# Phase 2: Executor Change (depends on Phase 1)
bd create "Wrap getSpreadMidpoint in try-catch" \
  --description "In execute-resolved.ts:~312, catch 422 from getSpreadMidpoint. Return RETRY_LLM outcome with failureContext." \
  --acceptance "npx tsc --noEmit passes, add test for 422 → RETRY_LLM"
# → bd-e5f6
bd dep add bd-e5f6 bd-a1b2
bd dep add bd-e5f6 bd-c3d4

# Phase 3: Orchestration (depends on Phase 2)
bd create "Detect RETRY_LLM in process-task.ts" \
  --description "Detect RETRY_LLM, call resolveLLMPath() with failure context. Cap at ONE retry (second 422 → MANUAL_REVIEW)." \
  --acceptance "npx tsc --noEmit passes, integration test covers retry path"
# → bd-g7h8
bd dep add bd-g7h8 bd-e5f6
```

Now `bd ready` only returns Phase 1 tasks. When both complete, Phase 2 unblocks automatically.

## Implementation Order

1. **`npm install -g @beads/bd`** then **`bd init`** in repo root
2. **`scripts/ralph.sh`** — already created, test on a small feature
3. **`.claude/agents/orchestrator.md`** — already created, use to decompose your first feature

## Scaling Up Later

| When | Add |
|---|---|
| Running 2+ parallel loops on same repo | Git worktrees (one loop per worktree, non-overlapping file scopes) |
| Running unsupervised for 8+ hours | Docker sandbox (constrain blast radius beyond permission rules) |
| 10+ concurrent agents | Gas Town or Multiclaude (not before) |

## Cost Estimates

- One Ralph loop: ~$10-15/hour (fresh context each iteration, Opus)
- Two parallel loops: ~$20-30/hour
- Interactive orchestrator session supervising loops: ~$5/hour (mostly idle, reading progress)
- Gas Town (20-30 agents): ~$100/hour — skip until the above is insufficient
