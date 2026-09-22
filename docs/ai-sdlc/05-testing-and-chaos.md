# Testing and Chaos Strategy

## Test layers

| Layer | Scope | Required proof |
|---|---|---|
| Unit | Pure state/ledger functions | legal transitions, exact amounts, balance-zero postings |
| Integration | PostgreSQL transactions | row locks, rollback, unique event keys, outbox/timer claims |
| Deterministic chaos | Named demo scenarios | duplicate, reorder, race, crash, time travel, courier failure |
| Stateful property | Model versus real system | invariants after every generated action |
| UI smoke | Three-panel workflow | Thai copy and committed realtime updates render correctly |
| Adapter contract | Port versus mock/real adapter contract | canonical provider events normalize identically and preserve correlation IDs |
| Observability | Structured logs | required IDs present; secrets and PINs never appear |

## Two property-test modes

### Live Quick Proof

- 500 generated sequences.
- Target: 30–60 seconds on the demo laptop.
- Runs against an isolated test database/schema.
- Streams progress, seed, and invariant status to the engineering console.

### Full Proof

- 5,000 generated sequences.
- Target: 3–8 minutes.
- Runs in CI and before the pitch; may also be launched from the console.
- Stores timestamp, seed, replay path, and minimized failing action trace.

## Mandatory deterministic scenarios

1. Same pickup event ID sent three times: one processing result, two duplicate-ignored results, one shipping release.
2. Delivered before pickup: no skipped state and no product release.
3. Buyer confirm, buyer dispute, and auto-release start together: one outcome and green invariant.
4. Worker crashes after Payment Core commit but before job acknowledgement: restart causes no double payout and finishes pending delivery.
5. Fast-forward 48 hours: due auto-release executes according to the injected clock.
6. Courier timeout/500: enters `PendingVerification` without a guessed fee.
7. Reset fixture restores seed state in under two seconds.

## Failpoint policy

Failures must be injected at named, deterministic boundaries, including `after_timer_claim`, `after_domain_commit`, and `before_outbox_ack`. Never rely on random process timing to demonstrate recovery.

## Worker performance learning goals

Record worker throughput and p50/p95/p99 latency at concurrency 1, 4, and 16. Profile CPU, heap, goroutine, block, and mutex contention before optimizing. If PostgreSQL locking or external I/O dominates, document that finding rather than adding goroutines blindly.

## Provider mock tests

- A mock payment provider must be able to return success, retryable error, permanent rejection, and timeout without changing ledger behaviour.
- Mock Courier must generate a valid HMAC signature and intentionally generate invalid signatures, duplicate IDs, delays, and reordering.
- Mock chat notification must record deliveries by stable notification ID and support a simulated failure before acknowledgement.
- Every adapter test asserts structured logs contain `trace_id`, provider name, operation, outcome, and latency, while excluding secrets and sensitive values.
