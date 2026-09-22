# Data Model and Correctness Rules

## Core tables

| Table | Responsibility | Key constraints/indexes |
|---|---|---|
| `orders` | Current state and immutable order identity | PK `id`; unique `shipment_token`; index `(state, ship_by)` |
| `ledger_entries` | Append-only double-entry postings | PK `id`; FK `order_id`; no update/delete path; index `(order_id, created_at)` |
| `processed_events` | Idempotency outcomes | unique `event_key`; index `(order_id, created_at)` |
| `timers` | Due work and lease state | index on `(status, due_at)` for worker claims |
| `outbox_events` | Durable notification/event delivery | index on `(status, available_at)` for worker claims |
| `domain_events` | Console/realtime audit projection | index `(order_id, occurred_at)` |
| `clock_state` | Injectable demo clock | singleton/configured clock value |

Exact columns and SQL constraints are part of the implementation plan, but these ownership boundaries are fixed.

## Ledger accounts

Required accounts:

- `buyer_available`
- `hold_suspense`
- `seller_available`
- `buyer_refund`

Every posting uses signed integer satang. The sum of postings for one ledger transaction is always zero.

Example for a 133500-satang hold:

1. Move 133500 from `buyer_available` to `hold_suspense`.
2. On valid pickup, move at most the courier-provided shipping amount from `hold_suspense` to `seller_available`.
3. On release, move remaining product amount from `hold_suspense` to `seller_available`.
4. On refund, move remaining amount from `hold_suspense` to `buyer_refund`.

`buyer_refund` is the final refund destination for this prototype. Do not add a second transfer back to `buyer_available`; this keeps terminal order accounting and the console T-account unambiguous.

## Invariants

After every committed domain transaction, validate:

1. Each ledger transaction balances to zero.
2. `shipping_released + product_released + refunded <= order_amount`.
3. For `Released` or `Refunded`, `shipping_released + product_released + refunded == order_amount`.
4. Global `hold_suspense` balance equals the sum of remaining amounts of all non-terminal orders.
5. A processed event key cannot create a second financial effect.

The reconciliation job independently recomputes the same rules from ledger entries and reports a green/red result to the console.

## Event outcome retention

`processed_events` records both successful and terminally rejected event outcomes. For example, `delivered` before `picked_up` is persisted as `rejected-invalid-transition`; the same `event_key` may never be evaluated again. The event log must distinguish this first rejection from later `duplicate-ignored` retries.
