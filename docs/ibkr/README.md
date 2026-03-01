# IBKR Integration Documentation

Source of truth for our Interactive Brokers integration: Java sidecar + TS client.

## Documents

| File | Content |
|---|---|
| [sidecar-api.md](sidecar-api.md) | REST + WebSocket API contract for the Java sidecar |
| [order-lifecycle.md](order-lifecycle.md) | State machine, every status, transition, callback, edge case |
| [error-codes.md](error-codes.md) | Complete TWS error code reference with classification |
| [risk-and-margin.md](risk-and-margin.md) | Margin monitoring, liquidation detection, account risk |
| [connection-and-operations.md](connection-and-operations.md) | Daily lifecycle, maintenance, reconnection, rate limits |
| [gaps-and-todos.md](gaps-and-todos.md) | Known gaps in sidecar + TS client, prioritized TODO list |

## Architecture

```
Discord signals
      ↓
  TS pipeline (src/broker/ibkr/client.ts)
      ↓ HTTP (localhost:8090)
  Java sidecar (sidecar/)
      ↓ TWS binary protocol
  IB Gateway (port 4001 live / 4002 paper)
      ↓
  IB servers → exchanges
```

## Quick Reference

- **Sidecar base URL**: `http://localhost:8090`
- **WebSocket**: `ws://localhost:8090/events`
- **IB Gateway live**: port 4001
- **IB Gateway paper**: port 4002
- **Maintenance window**: 00:15–01:45 ET daily
- **Account**: U14368257
