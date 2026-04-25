#!/usr/bin/env bash
# Install launchd agents for IB Gateway and the IBKR sidecar.
# These run independently of dev-up.ts and auto-restart on crash.
#
# Usage: bash scripts/install-launchd.sh [--uninstall]

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

GATEWAY_LABEL="com.tradefollower.ibgateway"
SIDECAR_LABEL="com.tradefollower.sidecar"
AGENT_LABEL="com.tradefollower.agent"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

if [[ "${1:-}" == "--uninstall" ]]; then
    echo "Unloading launchd agents..."
    launchctl bootout "gui/$(id -u)/$GATEWAY_LABEL" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/$SIDECAR_LABEL" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
    rm -f "$LAUNCH_DIR/$GATEWAY_LABEL.plist" "$LAUNCH_DIR/$SIDECAR_LABEL.plist" "$LAUNCH_DIR/$AGENT_LABEL.plist"
    echo "Done. Gateway, sidecar, and agent removed."
    exit 0
fi

mkdir -p "$LAUNCH_DIR" "$ROOT/data/logs"

# Resolve current node binary so nvm upgrades don't silently break the agent
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    echo "ERROR: node not on PATH. Activate the right nvm version and re-run." >&2
    exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

# ── IB Gateway via IBC ──────────────────────────────
cat > "$LAUNCH_DIR/$GATEWAY_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$GATEWAY_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$HOME/ibc/gatewaystartmacos.sh</string>
        <string>-inline</string>
    </array>
    <!-- HOME needed: gatewaystartmacos.sh resolves ~/ibc and ~/.nvm via tilde expansion. -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- 30s prevents rapid IBC reconnect loops that can trigger IBKR rate-limiting. -->
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$ROOT/data/logs/ibgateway.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT/data/logs/ibgateway.log</string>
</dict>
</plist>
EOF

# ── IBKR Sidecar ─────────────────────────────────────
cat > "$LAUNCH_DIR/$SIDECAR_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SIDECAR_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$ROOT/sidecar/scripts/start-sidecar.sh</string>
        <string>--paper</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$HOME</string>
        <key>IBKR_GATEWAY_PORT</key>
        <string>4002</string>
        <key>JAVA_HOME</key>
        <string>/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home</string>
        <!-- Explicit PATH so start-sidecar.sh finds \$JAVA_HOME's java before /usr/bin/java. -->
        <key>PATH</key>
        <string>/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- 30s avoids hammering a recovering Gateway; sidecar will reconnect once Gateway is stable. -->
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$ROOT/data/logs/sidecar.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT/data/logs/sidecar.log</string>
</dict>
</plist>
EOF

# ── Trading agent (src/index.ts via tsx) ────────────
cat > "$LAUNCH_DIR/$AGENT_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$AGENT_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$ROOT/node_modules/.bin/tsx</string>
        <string>src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- Restart on crash only. launchctl stop sends SIGTERM → exit 0 → no restart. -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>$ROOT/data/logs/agent-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$ROOT/data/logs/agent-stderr.log</string>
    <!-- 30s prevents a rapid crash loop (e.g. DB down at boot) from hammering the broker. -->
    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>
EOF

echo "Installing launchd agents..."
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/$GATEWAY_LABEL.plist" 2>/dev/null || launchctl load "$LAUNCH_DIR/$GATEWAY_LABEL.plist"
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/$SIDECAR_LABEL.plist" 2>/dev/null || launchctl load "$LAUNCH_DIR/$SIDECAR_LABEL.plist"
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/$AGENT_LABEL.plist" 2>/dev/null || launchctl load "$LAUNCH_DIR/$AGENT_LABEL.plist"

echo ""
echo "Installed:"
echo "  $GATEWAY_LABEL  — IB Gateway (paper mode, port 4002)"
echo "  $SIDECAR_LABEL  — IBKR sidecar (port 8090)"
echo "  $AGENT_LABEL    — Trading agent (src/index.ts)"
echo ""
echo "These auto-start on login and restart on crash."
echo "Node binary used: $NODE_BIN"
echo ""
echo "Optional: install log rotation policy (requires sudo):"
echo "  sudo install -m 644 scripts/launchd/tradefollower.newsyslog.conf /etc/newsyslog.d/tradefollower.conf"
echo ""
echo "To uninstall: bash scripts/install-launchd.sh --uninstall"
echo "Logs: data/logs/{ibgateway,sidecar,agent-stdout,agent-stderr}.log"
