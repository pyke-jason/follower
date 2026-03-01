# IBKR Sidecar Documentation

Implementation docs for our Java sidecar + TS client. For official IBKR TWS API reference, see [`../ibkr/`](../ibkr/).

## Architecture

```
Discord signals
      |
  TS pipeline (src/broker/ibkr/client.ts)
      | HTTP (localhost:8090)
  Java sidecar (sidecar/)
      | TWS binary protocol
  IB Gateway (port 4001 live / 4002 paper)
      |
  IB servers -> exchanges
```

## Documents

| File | Content |
|---|---|
| [api-contract.md](api-contract.md) | REST + WebSocket API contract for the Java sidecar |
| [implementation.md](implementation.md) | Error handling, status mapping, and implementation details |
| [gaps-and-todos.md](gaps-and-todos.md) | Known gaps, prioritized TODO list |

## Quick Reference

- **Sidecar base URL**: `http://localhost:8090`
- **WebSocket**: `ws://localhost:8090/events`
- **IB Gateway live**: port 4001
- **IB Gateway paper**: port 4002
- **Maintenance window**: 00:15-01:45 ET daily (sidecar blocks order placement)
- **Account**: U14368257

## Environment Variables

| Var | Default | Purpose |
|---|---|---|
| `IBKR_GATEWAY_HOST` | `127.0.0.1` | IB Gateway host |
| `IBKR_GATEWAY_PORT` | `4001` | Gateway port (4001=live, 4002=paper) |
| `IBKR_CLIENT_ID` | `1` | TWS client ID |
| `SIDECAR_PORT` | `8090` | HTTP server port |
| `HEALTHCHECK_PING_URL` | *(none)* | healthchecks.io ping URL (omit to disable) |
| `HEALTHCHECK_ENABLED` | `1` | Set `0` to disable healthcheck pings |
