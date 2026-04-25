#!/usr/bin/env bash
# Install (or uninstall) the launchd agent that runs nightly DB backups.
#
# The agent runs db-backup.sh at 02:00 every night.
# Logs go to data/logs/db-backup.log.
#
# Usage:
#   bash scripts/install-backup-launchd.sh             # install
#   bash scripts/install-backup-launchd.sh --uninstall # remove

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

LABEL="com.tradefollower.dbbackup"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
PLIST="${LAUNCH_DIR}/${LABEL}.plist"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Unloading $LABEL..."
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Done. Nightly backup agent removed."
  exit 0
fi

mkdir -p "$LAUNCH_DIR" "${ROOT}/data/logs"

# Resolve the full path to pg_dump so launchd (which has a minimal PATH) finds it.
# On macOS with `brew install postgresql@16` the binary lives in a keg-only path
# that is NOT in launchd's default PATH, so we must inject its dirname.
PG_DUMP_PATH="$(command -v pg_dump 2>/dev/null || true)"
if [[ -z "$PG_DUMP_PATH" ]]; then
  for candidate in \
    /opt/homebrew/opt/postgresql@16/bin/pg_dump \
    /opt/homebrew/opt/postgresql@15/bin/pg_dump \
    /opt/homebrew/bin/pg_dump \
    /usr/local/bin/pg_dump; do
    if [[ -x "$candidate" ]]; then
      PG_DUMP_PATH="$candidate"
      break
    fi
  done
fi
if [[ -z "$PG_DUMP_PATH" || ! -x "$PG_DUMP_PATH" ]]; then
  echo "ERROR: pg_dump not found. Install Postgres (brew install postgresql@16) and re-run." >&2
  exit 1
fi
PG_DUMP_DIR="$(dirname "$PG_DUMP_PATH")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${ROOT}/scripts/db-backup.sh</string>
    </array>

    <!-- Run at 02:00 every night -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>2</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <!-- Ensure pg_dump is on PATH regardless of login shell configuration -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PG_DUMP_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${ROOT}</string>

    <key>StandardOutPath</key>
    <string>${ROOT}/data/logs/db-backup.log</string>
    <key>StandardErrorPath</key>
    <string>${ROOT}/data/logs/db-backup.log</string>

    <!-- Retry if the machine was asleep at scheduled time -->
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF

echo "Installing $LABEL..."
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null \
  || launchctl load "$PLIST"

echo ""
echo "Installed: $LABEL"
echo "  Schedule:  02:00 nightly"
echo "  Script:    ${ROOT}/scripts/db-backup.sh"
echo "  Log:       ${ROOT}/data/logs/db-backup.log"
echo "  Backups:   ${HOME}/backups/trade-follower-3/"
echo "  Retention: 14 days"
echo ""
echo "To trigger immediately:  launchctl kickstart -k gui/\$(id -u)/${LABEL}"
echo "To uninstall:            bash scripts/install-backup-launchd.sh --uninstall"
