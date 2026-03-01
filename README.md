# Trade Follower 3

Autonomous trade-copy system: monitors a live trading chat room, classifies messages with AI, mirrors trades via broker API.

## How Work Gets Done

This repo uses an autonomous loop called **Ralph** to turn a single goal into shipped code. There are two steps and two entrypoints:

### Step 1: Plan (interactive Claude session)

Open a normal Claude Code session and describe what you want:

```
you: "handle the Databento 422 when parser extracts wrong strikes"
```

Claude reads the codebase, designs the approach, and creates beads tasks with dependencies:

```
beads-10: "Add failureContext type"              ← ready immediately
beads-11: "Add RETRY_LLM to outcome union"       ← ready immediately
beads-12: "Catch 422, return RETRY_LLM"          ← blocked by 10 + 11
beads-13: "Handle RETRY_LLM in process-task.ts"  ← blocked by 12
```

Each task has acceptance criteria (`tsc passes`, `specific test passes`) and lists the files to touch. You review the plan, adjust if needed, then move to step 2.

### Step 2: Execute (ralph.sh — separate terminal)

```bash
./scripts/ralph.sh
```

This is a bash while-loop. Each iteration:

1. Runs `bd ready` to find the next unblocked task
2. Spawns a **fresh `claude -p` session** (headless, no UI)
3. Claude reads the task, implements it, runs `tsc` + `vitest` to verify
4. Closes the task, exits
5. Loop sleeps 5s, starts a new session for the next task
6. When `bd ready` returns nothing, the loop exits

You don't watch it. You come back and everything is done (or a task failed its acceptance criteria and is still open for you to look at).

**Why fresh context per task matters**: no accumulated hallucinations, no forgetting earlier decisions. Every iteration reads the current state of the code and task list from scratch. This is the whole point of Ralph over a long-running session.

### The two entrypoints

| What | How | When |
|------|-----|------|
| Plan + create tasks | `claude` (normal interactive session) | You describe the goal, Claude creates beads |
| Execute tasks | `./scripts/ralph.sh` (headless loop) | After tasks exist, run it and walk away |

For small stuff (1-2 tasks), you can skip Ralph and just let Claude do it in the interactive session. Ralph shines when there are 5+ tasks and you want hands-off execution with verified results.

### What Makes a Good Task

Each task is one Ralph iteration. It should be:

- **Small**: 1-5 files. Bigger means break it down.
- **Specific**: "Extract parser into standalone module, update 3 imports" not "refactor parser"
- **Verifiable**: criteria a machine can check — `tsc passes`, `vitest run passes`

Bad: "Make the executor more robust"
Good: "Catch Databento 422 in execute-resolved.ts:~312. Return RETRY_LLM outcome with { errorCode, occSymbol, invalidStrike }. Add test that 422 response produces RETRY_LLM."

### How Dependencies Work

`bd ready` only returns tasks with no open blockers. That's it — that's the scheduling.

When Claude creates tasks in step 1, it wires up deps so phases execute in order. Phase 1 tasks (no deps) are ready first. When they close, phase 2 unblocks. The Ralph loop doesn't need to know about phases — it just keeps asking `bd ready` for whatever's next.

### Current Status

| Piece | Ready? |
|-------|--------|
| Beads (bd) issue tracker | Yes — `.beads/` initialized, hooks installed |
| Coding standards + type safety | Yes — `CLAUDE.md`, strict tsconfig, vitest |
| Permission sandbox | Yes — `.claude/settings.local.json` |
| Ralph loop (`scripts/ralph.sh`) | Not yet — see `docs/plans/agent-orchestration.md` |
| Orchestrator agent (`.claude/agents/orchestrator.md`) | Not yet |

Until ralph.sh exists, Claude works through tasks in a single interactive session. Ralph just automates the "fresh context per task" part.

## Beads Quick Reference

Mostly used by Claude, but handy for checking progress or filing something yourself.

| What | Command |
|------|---------|
| What's ready? | `bd ready` |
| All open issues | `bd list --status=open` |
| Issue details | `bd show <id>` |
| Create a task | `bd create --title="..." --description="..." --type=task --priority=1` |
| Claim it | `bd update <id> --status=in_progress` |
| Done | `bd close <id>` |
| Done with reason | `bd close <id> --reason="explanation"` |
| Close several | `bd close <id1> <id2> <id3>` |
| Add dependency | `bd dep add <child> <parent>` |
| What's blocked? | `bd blocked` |
| Dependency graph | `bd graph <id>` |
| Search | `bd search "keyword"` |
| Project stats | `bd status` |
| Health check | `bd doctor` |
| Sync to remote | `bd dolt push` |

Types: `bug` `feature` `task` `chore` `epic`

Priorities: `0` critical → `4` backlog (default `2`)
