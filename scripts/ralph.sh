#!/usr/bin/env bash
# Ralph — autonomous task execution loop.
# Each iteration spawns a fresh headless Claude session on one task.
# No context decay: every iteration reads the codebase from scratch.
#
# Usage:  ./scripts/ralph.sh [--dry-run] [--max-budget N]
#
# Requires: claude CLI, bd CLI, both in PATH.
set -euo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
DRY_RUN=false
MAX_BUDGET=4          # USD per task (safety rail)
SLEEP_BETWEEN=5       # seconds between iterations

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --max-budget) shift; MAX_BUDGET="$1" ;;
    --max-budget=*) MAX_BUDGET="${arg#*=}" ;;
  esac
  shift 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
command -v claude >/dev/null 2>&1 || { echo "error: claude CLI not found"; exit 1; }
command -v bd     >/dev/null 2>&1 || { echo "error: bd CLI not found"; exit 1; }

echo "ralph: starting (max-budget=\$${MAX_BUDGET}/task, sleep=${SLEEP_BETWEEN}s)"

# ---------------------------------------------------------------------------
# Loop
# ---------------------------------------------------------------------------
ITERATION=0

while true; do
  ITERATION=$((ITERATION + 1))

  # Find the next unblocked task
  READY_OUTPUT=$(bd ready --short 2>&1) || true

  # bd ready exits 0 with output when tasks exist, or prints nothing / errors
  TASK_ID=$(echo "$READY_OUTPUT" | head -1 | awk '{print $1}')

  if [[ -z "$TASK_ID" || "$TASK_ID" == "No" || "$TASK_ID" == "Error"* ]]; then
    echo "ralph: no tasks ready — done."
    break
  fi

  echo ""
  echo "ralph: ── iteration ${ITERATION} ──────────────────────────────"
  echo "ralph: picked ${TASK_ID}"

  if $DRY_RUN; then
    echo "ralph: [dry-run] would execute ${TASK_ID}"
    bd show "$TASK_ID" --short 2>/dev/null || true
    sleep 1
    continue
  fi

  # Claim before spawning Claude so parallel loops don't collide
  bd update "$TASK_ID" --claim 2>/dev/null || {
    echo "ralph: could not claim ${TASK_ID} (already claimed?), skipping"
    sleep "$SLEEP_BETWEEN"
    continue
  }

  PROMPT=$(cat <<EOF
You are Ralph, an autonomous coding agent. You have ONE task to complete.

## Your task
Run: bd show ${TASK_ID}
Read the full description and acceptance criteria carefully.

## Workflow
1. Read the task (bd show ${TASK_ID})
2. Read CLAUDE.md for coding standards
3. Read the relevant source files listed in the task
4. Implement the changes
5. Verify: run \`npx tsc --noEmit\` and \`npx vitest run\` (or the specific test command in the acceptance criteria)
6. If verification passes: run \`bd close ${TASK_ID} --reason="done" --suggest-next\`
7. If verification fails: fix the issue and re-verify. Do NOT close a task that fails its acceptance criteria.

## Rules
- Work on ONLY this one task. Do not touch unrelated code.
- Follow CLAUDE.md coding standards strictly.
- Do not create new files unless the task explicitly requires it.
- Do not skip or weaken acceptance criteria.
- If you are stuck and cannot complete the task, leave it open (do not close it).
EOF
)

  echo "ralph: spawning claude for ${TASK_ID}..."

  # Spawn headless Claude. Capture exit code but don't let it kill the loop.
  set +e
  claude -p "$PROMPT" \
    --dangerously-skip-permissions \
    --max-budget-usd "$MAX_BUDGET" \
    --verbose 2>&1 | while IFS= read -r line; do
      echo "  [${TASK_ID}] $line"
    done
  EXIT_CODE=${PIPESTATUS[0]}
  set -e

  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "ralph: claude exited with code ${EXIT_CODE} for ${TASK_ID}"
  fi

  # Check if the task was actually closed
  TASK_STATUS=$(bd show "$TASK_ID" --short 2>/dev/null | awk '{print $2}') || true
  if [[ "$TASK_STATUS" == *"closed"* || "$TASK_STATUS" == *"resolved"* ]]; then
    echo "ralph: ${TASK_ID} completed ✓"
  else
    echo "ralph: ${TASK_ID} still open (claude may have gotten stuck)"
  fi

  echo "ralph: sleeping ${SLEEP_BETWEEN}s..."
  sleep "$SLEEP_BETWEEN"
done

echo "ralph: all done."
