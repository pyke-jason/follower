# IBKR TWS API Reference

Source of truth for Interactive Brokers TWS API behavior. Verified against official IBKR documentation at [interactivebrokers.github.io/tws-api/](https://interactivebrokers.github.io/tws-api/).

This directory documents **how IBKR works**, not how our sidecar implements it. Sidecar source: `sidecar/`, TS client: `src/broker/ibkr/`.

## Documents

| File | Content |
|---|---|
| [order-lifecycle.md](order-lifecycle.md) | Order status values, state machine, callbacks, partial fills, combos |
| [error-codes.md](error-codes.md) | Complete TWS error code reference with classification |
| [connection.md](connection.md) | Connection lifecycle, maintenance windows, reconnection, rate limits |
| [risk-and-margin.md](risk-and-margin.md) | Margin system, liquidation detection, account monitoring, PDT |

## Key Links

- [TWS API Docs](https://interactivebrokers.github.io/tws-api/)
- [TWS API Message Codes](https://interactivebrokers.github.io/tws-api/message_codes.html)
- [IBKR System Status](https://www.interactivebrokers.com/en/software/systemStatus.php)
- [IBKR Campus](https://www.interactivebrokers.com/campus/)

## API Version Notes (TWS API 10.40+, Server Version 215)

Breaking changes from earlier API versions:

| Change | Old | New (10.40+) |
|---|---|---|
| Error callback | `error(int id, int errorCode, String msg, String json)` | `error(int id, long errorTime, int errorCode, String msg, String json)` |
| Commission report | `CommissionReport` / `commission()` | `CommissionAndFeesReport` / `commissionAndFees()` |
| Cancel order | `cancelOrder(int orderId, String time)` | `cancelOrder(int orderId, OrderCancel cancel)` |
| Decimal type | N/A | `Decimal` has no `.doubleValue()` -- use `.value().doubleValue()` |
| Order status permId | `int` | `long` |
| EWrapper | `implements EWrapper` | `extends DefaultEWrapper` (ProtoBuf stubs) |
| ProtoBuf dependency | N/A | Required: `com.google.protobuf:protobuf-java:4.29.3` |
