#!/usr/bin/env bash
# Wrapper for launchd — sources .env then execs the agent under caffeinate.
set -euo pipefail

cd "$(dirname "$0")/.."

# Export all variables from .env
set -a
source .env
set +a

exec caffeinate -s -- npx tsx src/index.ts
