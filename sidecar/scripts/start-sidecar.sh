#!/usr/bin/env bash
# Start the IBKR sidecar.
# Usage: ./scripts/start-sidecar.sh [--paper]
#
# Mode selection (in priority order):
#   1. --paper flag → paper mode
#   2. IBKR_MODE env var (paper|live)
#   3. Default → live
#
# Env vars:
#   IBKR_MODE          — Trading mode: paper or live (default: live)
#   IBKR_GATEWAY_PORT  — Gateway port (default: 4001 live, 4002 paper)
#   SIDECAR_PORT       — HTTP port (default: 8090)
#   IBKR_CLIENT_ID     — TWS client ID (default: 1)

set -euo pipefail
cd "$(dirname "$0")/.."

# Determine mode from flag or env
if [[ "${1:-}" == "--paper" ]] || [[ "${IBKR_MODE:-}" == "paper" ]]; then
    export IBKR_MODE="paper"
    export IBKR_GATEWAY_PORT="${IBKR_GATEWAY_PORT:-4002}"
    echo "Starting sidecar in PAPER TRADING mode (port ${IBKR_GATEWAY_PORT})"
else
    export IBKR_MODE="${IBKR_MODE:-live}"
    export IBKR_GATEWAY_PORT="${IBKR_GATEWAY_PORT:-4001}"
fi

JAR="build/libs/ibkr-sidecar-1.0.0.jar"

if [[ ! -f "$JAR" ]]; then
    echo "Building sidecar..."
    if [[ -f "lib/TwsApi.jar" ]]; then
        ./gradlew jar
    else
        echo "ERROR: lib/TwsApi.jar not found. Download from https://interactivebrokers.github.io"
        exit 1
    fi
fi

echo "Starting IBKR sidecar (mode=${IBKR_MODE}, gateway=${IBKR_GATEWAY_PORT}, http=${SIDECAR_PORT:-8090})"
exec java -jar "$JAR"
