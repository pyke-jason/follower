#!/usr/bin/env bash
# Start the IBKR sidecar.
# Usage: ./scripts/start-sidecar.sh [--paper]
#
# Env vars:
#   IBKR_GATEWAY_PORT  — Gateway port (default: 4001 live, 4002 paper)
#   SIDECAR_PORT       — HTTP port (default: 8090)
#   IBKR_CLIENT_ID     — TWS client ID (default: 1)

set -euo pipefail
cd "$(dirname "$0")/.."

# Paper trading mode
if [[ "${1:-}" == "--paper" ]]; then
    export IBKR_GATEWAY_PORT="${IBKR_GATEWAY_PORT:-4002}"
    echo "Starting sidecar in PAPER TRADING mode (port ${IBKR_GATEWAY_PORT})"
else
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

echo "Starting IBKR sidecar (gateway=${IBKR_GATEWAY_PORT}, http=${SIDECAR_PORT:-8090})"
exec java -Xmx256m -XX:+UseG1GC -jar "$JAR"
