#!/bin/bash
# Ralph loop — autonomous single-task execution with fresh context per iteration.
# Requires: beads (`bd`) installed globally, `bd init` run in repo root.
#
# Usage:
#   ./scripts/ralph.sh                    # run until all beads resolved
#   ./scripts/ralph.sh --max-iterations 5 # cap at 5 iterations

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MAX_ITERATIONS=0  # 0 = unlimited
ITERATION=0
LOG_DIR=".logs/ralph"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y%m%d-%H%M%S).log"

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --max-iterations) MAX_ITERATIONS="$2"; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
  shift
done

echo "Ralph loop started. Log: $LOG_FILE"
echo "---" | tee -a "$LOG_FILE"

while true; do
  ITERATION=$((ITERATION + 1))

  if [[ "$MAX_ITERATIONS" -gt 0 && "$ITERATION" -gt "$MAX_ITERATIONS" ]]; then
    echo "Hit max iterations ($MAX_ITERATIONS). Stopping." | tee -a "$LOG_FILE"
    break
  fi

  echo "=== Iteration $ITERATION ($(date +%H:%M:%S)) ===" | tee -a "$LOG_FILE"

  OUTPUT=$(claude -p \
    "You are a single-task worker in an autonomous loop. Follow these steps exactly:

1. Run 'bd ready' to see available (unblocked) tasks.
2. If no tasks are returned, output <promise>COMPLETE</promise> and stop.
3. Otherwise, pick the FIRST task listed. Run 'bd show <id>' to read its full description and acceptance criteria.
4. Claim it: 'bd update <id> --claim'
5. Implement the task. Read CLAUDE.md for coding standards.
6. Verify acceptance criteria — at minimum run 'npx tsc --noEmit' and 'npx vitest run --reporter=verbose'.
7. If verification passes, mark done: 'bd update <id> --resolve'
8. If verification fails, fix the issue and re-verify. Do NOT mark done until criteria pass.

RULES:
- ONLY work on ONE task per iteration.
- Do NOT start a second task after resolving one — just stop.
- Commit your changes with a descriptive message before stopping.
- If you are stuck after 3 attempts on the same error, leave the task claimed (do not resolve) and stop." \
    --dangerously-skip-permissions 2>&1) || true

  echo "$OUTPUT" >> "$LOG_FILE"

  # Print last 20 lines to terminal for quick status
  echo "$OUTPUT" | tail -20

  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo "" | tee -a "$LOG_FILE"
    echo "All tasks complete after $ITERATION iterations." | tee -a "$LOG_FILE"
    break
  fi

  echo "--- sleeping 5s ---" | tee -a "$LOG_FILE"
  sleep 5
done
