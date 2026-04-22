# Battery Alerts (Mac About To Die)

## Problem
Backend and sidecar die silently when the MacBook shuts down from a drained battery, leaving live positions unmanaged. No signal reaches the user's phone.

## Decision
Add a `startBatteryMonitor()` polling loop in the orchestrator (`scripts/dev-up.ts`). Every 60s it runs `pmset -g batt`, parses power source / percent / time-remaining, and routes low-battery events through the existing `sendSystemAlert()` (Discord + Pushover siren on critical).

- Warning at <=25% while discharging.
- Critical at <=10% OR <=15 minutes remaining while discharging.
- Alert flags reset whenever the machine goes back on AC or charging, so a user who unplugs/plugs repeatedly still gets future alerts.

The monitor lives in the orchestrator, not the backend, because the backend itself dies during shutdown — the orchestrator holds longer and pushes the final warning.

## Key Files
- `src/lib/battery-monitor.ts` — parser + tick loop.
- `src/lib/battery-monitor.test.ts` — parse coverage for charging / discharging / charged / garbage.
- `scripts/dev-up.ts` — wires `startBatteryMonitor()` into `main()`.

## Watch Out
- `pmset` output format is stable enough to regex but varies when no battery is present (desktop Mac). The parser returns `null` when no `InternalBattery` line exists; monitor tolerates that silently.
- Pushover only fires on `severity: 'critical'`. Warning-level low-battery events stay on Discord only — intentional, so a phone siren fires only when power is actually imminent.
- `BATTERY_MONITOR_ENABLED=0` disables the monitor; non-darwin platforms are skipped automatically.
