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
  │ - Spawns Ralph loop(s)
  │ - Monitors progress (bd list), plans next phase when current completes
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
| Ralph loop | Missing | `scripts/ralph.sh` |
| Orchestrator agent | Missing | `.claude/agents/orchestrator.md` |
| Beads task tracker | Missing | `bd init` → `.beads/` |
| Docker sandbox | Optional | Not needed yet |

## Files to Create

### 1. `scripts/ralph.sh` — The Execution Loop

A bash while-loop that restarts Claude with fresh context each iteration. Context decay is impossible because every iteration reads the plan and codebase from scratch.

```bash
#!/bin/bash
while true; do
  OUTPUT=$(claude -p \
    "Run 'bd ready' to see available tasks. If no tasks remain, output <promise>COMPLETE</promise>. \
     Otherwise pick the first task. Run 'bd show <id>' to read its full description and acceptance criteria. \
     Claim it: 'bd update <id> --claim'. \
     Implement it. Run 'npx tsc --noEmit' and 'npx vitest run' to verify acceptance criteria. \
     Mark done: 'bd update <id> --resolve'. \
     ONLY WORK ON A SINGLE TASK." \
    --dangerously-skip-permissions 2>&1)

  echo "$OUTPUT"

  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo "All tasks complete."
    break
  fi

  sleep 5
done
```

**Why fresh context matters**: Each iteration gets the full context window. No accumulated hallucinations, no forgetting earlier decisions. Claude reads the current state of files and progress every time. This is the killer feature over long-running sessions.

### 2. `.claude/agents/orchestrator.md` — The PM Brain

An agent that decomposes goals into Ralph-sized tasks. Never writes code itself.

```yaml
---
name: orchestrator
description: Project orchestrator. Decomposes goals into tasks. Never writes code.
model: opus
---
```

Workflow:
1. User gives a high-level goal
2. Reads CLAUDE.md, AGENTS.md, relevant source files
3. Decomposes into phases, each phase into tasks
4. Creates beads: `bd create "task title" --description "..." --acceptance "tsc passes, tests pass"`
5. Sets dependencies: `bd dep add <child> <parent>` so tasks unblock in order
6. Each task must be completable in one Ralph iteration (single feature, <5 files)
7. Every task's acceptance criteria must be mechanically verifiable (tsc passes, specific test passes)

Rules:
- Never write code — only plan
- A task that touches more than 5 files is too big, break it down
- "Make it cleaner" is not a task. "Extract X into Y and update imports" is
- Include the specific files to read and modify in each task description

### 3. Beads Task Tracker — `bd init`

Install globally (`npm install -g @beads/bd` or `brew install beads`), then `bd init` in the repo root. Creates a `.beads/` directory and `issues.jsonl` (the git-committed sync file).

The killer feature is `bd ready` — returns only unblocked tasks. The Ralph loop calls this each iteration instead of parsing a markdown checklist. Dependencies between tasks are first-class (`bd dep add <child> <parent>`), so phase ordering is automatic.

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

Now `bd ready` only returns Phase 1 tasks. When both complete, Phase 2 unblocks automatically. No manual progress tracking needed — beads tracks status, the Ralph loop just asks what's next.

## Implementation Order

1. **`npm install -g @beads/bd` + `bd init`** — task tracker with dependency-aware `bd ready`
2. **`scripts/ralph.sh`** — the execution loop, test on a small feature
3. **`.claude/agents/orchestrator.md`** — automates task decomposition into beads

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
