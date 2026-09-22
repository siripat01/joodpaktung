# Agent Workflow

## Before each implementation task

1. Read the documents relevant to the task and the Terra decision register it touches.
2. State which invariant and failure mode the task protects.
3. Add or update a failing test before changing domain behaviour.
4. Keep the change within one clear component boundary.

## Required verification

- Unit test for the local rule.
- Integration test whenever a transaction, lock, uniqueness constraint, timer, outbox, or worker lease changes.
- Deterministic chaos scenario when recovery or concurrency behaviour changes.
- Re-run reconciliation after changes that affect ledger or order state.

## Change restrictions

- Never add mutable balances as a source of truth.
- Never place an external network call inside a Payment Core database transaction.
- Never allow a worker to directly post ledger entries or transition an order.
- Never treat `LISTEN/NOTIFY` as a durable queue.
- Never call a KBank, courier, or LINE API from domain code; add or modify an adapter behind its port instead.
- Never log PINs, HMAC secrets, authentication headers, access tokens, or raw personal data.
- Never optimize based only on a microbenchmark; capture representative worker metrics and a profile first.

## Documentation upkeep

Update this AI-SDLC folder whenever a decision changes. Terra records a new ordinary POC decision in `10-autonomous-decisions.md` before implementing around it; stop only for the exceptional cases named there.
