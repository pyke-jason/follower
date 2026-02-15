#!/usr/bin/env bash
# Start the trade follower daemon and prevent sleep.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.tradefollower.agent.plist"

if [ ! -f "$PLIST" ]; then
  echo "Plist not found. Run setup-daemon.sh first."
  exit 1
fi

sudo pmset -a disablesleep 1
echo "[ok] Sleep disabled"

launchctl load "$PLIST" 2>/dev/null || true
echo "[ok] LaunchAgent loaded"
echo ""
echo "Daemon is running. Check: launchctl list | grep tradefollower"
