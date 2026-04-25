# peaceful-cannon-d44788 — launchd installation hardening

## Goal

Make the macOS deployment self-restarting and crash-resilient so that going live doesn't depend on a tmux session or an attended `npm run up`. The worktree ships:

1. A new launchd plist for the **agent** itself (`tsx src/index.ts`), so the trading process auto-starts on login and restarts on crash.
2. A `newsyslog.d` rotation policy for agent + gateway + sidecar logs.
3. Hardening of the existing `install-launchd.sh` (gateway + sidecar plists) so they actually find Java / IBC at boot time when launchd's `PATH` is minimal.
4. A small change in `sidecar/scripts/start-sidecar.sh` so the script honors `JAVA_HOME` rather than whatever `java` happens to be on `PATH`.

## Changes

- `scripts/launchd/com.tradefollower.agent.plist` (new). Runs `/Users/jason/.nvm/versions/node/v22.22.1/bin/node node_modules/.bin/tsx src/index.ts` from the repo root with `NODE_ENV=production`. `KeepAlive={SuccessfulExit:false}` so a clean SIGTERM via `launchctl stop` does not relaunch; non-zero exits do. `ThrottleInterval=30`. Logs to `data/logs/agent-stdout.log` / `agent-stderr.log`. Comment in-file warns to bump the node version path on nvm upgrade.
- `scripts/launchd/tradefollower.newsyslog.conf` (new). Daily rotation at 50 MB, gzip-compressed, 14-day retention for the four log files. Header tells operator to `sudo cp` it to `/etc/newsyslog.d/tradefollower.conf`.
- `scripts/install-launchd.sh` (modified). Adds `EnvironmentVariables` blocks to both the gateway plist (HOME + PATH) and the sidecar plist (HOME + PATH + JAVA_HOME). Bumps sidecar `ThrottleInterval` from 10s to 30s. Inline rationale comments for each addition.
- `sidecar/scripts/start-sidecar.sh` (modified). Replaces `exec java …` with `exec "${JAVA_HOME:+$JAVA_HOME/bin/}java" …` and echoes the resolved binary.

## Justification per change

- **Agent auto-restart plist.** Direct `tsx src/index.ts` invocation is correct; this matches `package.json`'s `dev` script and `src/index.ts` is the live ingestion+execution entry. Hardcoded NVM path is the right tradeoff vs sourcing `nvm.sh` in launchd (which would require a login-shell wrapper). The `KeepAlive={SuccessfulExit:false}` shape is the canonical idiom for "restart only on crash" — important so a deliberate stop during a deploy doesn't fight the operator. `RunAtLoad=true` covers reboots.
- **Gateway/sidecar PATH+HOME injections.** `gatewaystartmacos.sh` from IBC genuinely does tilde-expand `~/ibc` and call `nvm`/`java` from `PATH`; without this, the gateway plist works only because the user has a non-launchd shell that already happens to have the right env. Adding `HOME` and a real `PATH` removes that hidden coupling.
- **Sidecar ThrottleInterval 10→30.** Reasonable: 10s rapid restarts hammer a recovering Gateway and can earn IBKR rate limits.
- **start-sidecar.sh JAVA_HOME-prefixed binary.** Closes the loophole where `JAVA_HOME` is exported but `java` on `PATH` resolves to `/usr/bin/java` (which on macOS is a stub launcher). Backwards-compatible: when `JAVA_HOME` is unset, parameter expansion yields plain `java`.
- **newsyslog config.** macOS-native (no extra dependencies, runs daily via `com.apple.newsyslog`). 50 MB / 14-day retention is sane for a single-user system that may emit verbose logs during a market open.

## Concerns

1. **The new agent plist is never installed.** `scripts/install-launchd.sh` writes only `com.tradefollower.ibgateway.plist` and `com.tradefollower.sidecar.plist`. The new `scripts/launchd/com.tradefollower.agent.plist` and `tradefollower.newsyslog.conf` are loose files that the operator must `cp` into `~/Library/LaunchAgents/` and `launchctl bootstrap` by hand. The `--uninstall` path also does not know about the agent label, so a cleanup leaves the agent plist behind. This is the single biggest issue: the central goal of this worktree (auto-restart the trading agent) is half-implemented — the artifact exists, but the install path doesn't pick it up.
2. **NVM version path is a tripwire.** `/Users/jason/.nvm/versions/node/v22.22.1/bin/node` is an exact path. The operator has both `v20.16.0` and `v22.22.1` installed today. The in-file comment acknowledges the risk, but the agent plist is hand-installed (see #1), so any `nvm install` of a newer LTS plus `nvm alias default` silently leaves the launchd plist pinned to the old node. Worktree should at minimum (a) compute this path in a wrapper script under `scripts/launchd/` so the resolved binary is sourced from `nvm` at start time, or (b) substitute via the install script with `$(readlink -f "$(command -v node)")`.
3. **newsyslog requires `sudo cp` and is silent.** The conf file is a static artifact with an instruction comment — no installer step copies it to `/etc/newsyslog.d/`. Operationally this means logs grow unbounded until someone reads the comment header.
4. **No lesson file.** Project rule mandates `docs/lessons/YYYY-MM-DD-slug.md` after every implementation session. None exists for these launchd changes. The four lessons under 2026-04-24 are unrelated.
5. **Gateway PATH lacks `$HOME/ibc` and friends.** IBC's `gatewaystartmacos.sh` may also need its install dir on `PATH` for some sub-tools; the chosen `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` is a reasonable baseline but unverified for this specific IBC version. Low risk because the gateway plist already works in main without the env at all.
6. **Sidecar plist passes `--paper` and port 4002 hard-coded.** Pre-existing in main; not changed here. For going live, the install script will eventually need a `--live`/`--paper` flag. Out of scope but worth flagging.
7. **Idempotency.** The install script overwrites plists each run via `cat > … <<EOF` and uses `bootstrap … || load`. Re-running while an agent is already loaded will fail the `bootstrap` (already loaded) and then `load` will also fail silently because of the `2>/dev/null`. The plists on disk get overwritten but the running daemon keeps using the old in-memory copy until next bootout. Not strictly broken — re-running after `--uninstall` works — but a simple `bootout`-then-`bootstrap` sequence would be cleaner. Minor.

## Verdict — REWORK

The direction is exactly right and most of the diff is high-signal and low-bloat: no defensive shell complexity, comments explain the *why*, throttle and KeepAlive shapes are correct, the JAVA_HOME fix is real, and the newsyslog policy is the right tool. But the headline deliverable — the agent auto-restart — is a loose file that the install script ignores. By the rubric's own definition, a plist that doesn't actually get loaded is theatre. Twenty additional lines in `install-launchd.sh` would close the loop. Once that's done plus a lesson file, this is a clean merge.

## Required fixes

1. **Wire the agent plist into `install-launchd.sh`.** Add a third `cat > "$LAUNCH_DIR/com.tradefollower.agent.plist" <<EOF … EOF` block (or, better, `cp` from `scripts/launchd/com.tradefollower.agent.plist` and template-substitute `$HOME` / `$ROOT` / the node path). Include the `bootstrap`/`load` line. Add `bootout` + `rm -f` lines for the agent label to the `--uninstall` branch. Update the final summary `echo` to mention the agent.
2. **Resolve the NVM node path dynamically** in the install script — e.g. `NODE_BIN="$(readlink -f "$(command -v node)")"` then substitute it into the plist heredoc — so `nvm install` upgrades don't silently break the agent at next reboot. Keep the in-file comment as a backstop.
3. **Install the newsyslog conf** as part of the script (with a `sudo` prompt and a clear log line), or document it in the final `echo` block alongside the existing logs hint. `sudo install -m 644 scripts/launchd/tradefollower.newsyslog.conf /etc/newsyslog.d/tradefollower.conf` is enough.
4. **Add `docs/lessons/2026-04-24-launchd-auto-restart.md`** per the project rule, summarizing: the auto-restart contract (`KeepAlive.SuccessfulExit=false`), the JAVA_HOME / PATH gotchas, the `nvm` version pinning hazard, and the manual `--paper`/`--live` switch deferred to a later worktree.
5. **Optional but cheap:** make the install script idempotent by `launchctl bootout … 2>/dev/null || true` *before* `bootstrap`, so re-running picks up plist edits without an explicit `--uninstall`.

## Reviewer verdict

Falsification pass confirms the thesis. Every named concern reproduced:

- `scripts/install-launchd.sh` writes only gateway + sidecar plists. The new `scripts/launchd/com.tradefollower.agent.plist` is an unreferenced loose file; `--uninstall` does not know the agent label. Headline deliverable is half-wired.
- Agent plist hardcodes `/Users/jason/.nvm/versions/node/v22.22.1/bin/node`. Both `v20.16.0` and `v22.22.1` are installed on this box — a future `nvm alias default` flip silently breaks the agent at next reboot.
- `tradefollower.newsyslog.conf` requires manual `sudo cp`; install script doesn't mention it in its final echo. Logs grow unbounded by default.
- No lesson file under `docs/lessons/2026-04-24-*launchd*`. The four 2026-04-24 lessons on file are about agent refs, trade quality, equity curves, and dashboard messages.
- `KeepAlive={SuccessfulExit:false}` shape is correct; `RunAtLoad` + `ThrottleInterval=30` are set; comments explain the *why* without shell bloat. JAVA_HOME fix in `start-sidecar.sh` is real — `/usr/bin/java` on macOS is a stub launcher, so `${JAVA_HOME:+$JAVA_HOME/bin/}java` closes a genuine gap.

Additional findings not in the thesis:

- **Unattended reboot hazard.** The agent plist is a LaunchAgent with default `LimitLoadToSessionType=Aqua`. It only loads once a graphical user session starts. A power-cycle without auto-login leaves the trading agent dormant until someone logs in. For a "going live, self-restarting" story this is the bigger gap than nvm pinning. Either document that macOS auto-login is required, or graduate to a LaunchDaemon (runs as root, needs `UserName=jason`, and needs secrets/Keychain access reworked — non-trivial).
- **Repo path is hardcoded** in the agent plist (`/Users/jason/Workspace/trade-follower-3`). Moving the checkout breaks the plist silently. The install script already has `$ROOT`; templating the agent plist the same way as the gateway/sidecar ones would fix nvm pinning and repo pinning in one change.
- **`LSBackgroundOnly` is a non-issue.** LaunchAgents for headless node processes don't need it; thesis correctly omits.
- Gateway/sidecar plists route stderr to the same file as stdout — pre-existing, minor, not a regression.

Overall: REWORK stands. Direction is right, the `KeepAlive.SuccessfulExit=false` / `ThrottleInterval=30` / `JAVA_HOME` pieces are high-signal. Required fixes 1–4 are correct and sufficient; I would add a fifth: document (or enable) macOS auto-login, or promote the agent plist to a LaunchDaemon, so unattended reboots actually come back online.

Path: /Users/jason/Workspace/trade-follower-3/.claude/worktree-review/peaceful-cannon-d44788.md
