#!/usr/bin/env bash
# One-time setup: install launchd agent + prevent sleep on lid close.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/scripts/com.tradefollower.agent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.tradefollower.agent.plist"

echo "=== Trade Follower Daemon Setup ==="
echo "Project dir: $PROJECT_DIR"

# 1. Create log directory
mkdir -p "$PROJECT_DIR/data/logs"

# 2. Generate plist with resolved paths
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PLIST_SRC" > "$PLIST_DST"
echo "[ok] Installed plist → $PLIST_DST"

# 3. Prevent sleep on lid close (requires sudo)
echo ""
echo "Disabling macOS sleep (requires sudo)..."
sudo pmset -a disablesleep 1
echo "[ok] Sleep disabled (revert with: sudo pmset -a disablesleep 0)"

# 4. Load the agent
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "[ok] LaunchAgent loaded"

echo ""
echo "Done! The agent will now:"
echo "  • Start automatically on login"
echo "  • Restart if it crashes"
echo "  • Keep running when the lid is closed"
echo ""
echo "Manage with:"
echo "  launchctl list | grep tradefollower   # check status"
echo "  launchctl unload $PLIST_DST           # stop"
echo "  launchctl load   $PLIST_DST           # start"
echo "  tail -f $PROJECT_DIR/data/logs/agent-stderr.log  # logs"
