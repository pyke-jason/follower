#!/usr/bin/env bash
# Stop the trade follower daemon and re-enable sleep.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.tradefollower.agent.plist"

launchctl unload "$PLIST" 2>/dev/null || true
echo "[ok] LaunchAgent unloaded"

sudo pmset -a disablesleep 0
echo "[ok] Sleep re-enabled"
echo ""
echo "Daemon stopped. Safe to close the lid."
