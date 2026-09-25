# Task 7 Handoff

Status: IMPLEMENTED_WITH_TOOLCHAIN_BLOCKER

## Delivery

Implemented the Go timer/outbox lease worker with PostgreSQL `SKIP LOCKED` claims, unique per-claim fencing tokens, wall-clock operational leases and retry backoff, injected-clock timer eligibility, bounded concurrent batch processing, graceful shutdown, and structured correlated logs.

Timer commands carry the persisted event key and lease token to Payment Core. Core is the only component that completes timers and does so in the same transaction as the idempotent command outcome. Stale or expired claims roll the entire command back. Outbox delivery uses a provider-neutral interface and a durable local provider table keyed by `notification_key`, proving idempotency across process restart and a crash before acknowledgement.

D-018 records the local-provider, clock, fencing, retry, and audit-boundary decisions. Fixture reset clears local-provider state. Deterministic `after_timer_claim` and `before_outbox_ack` failpoints are wired; `after_domain_commit` remains a Core-owned boundary.

## Verification

- Core TypeScript typecheck passed.
- Go formatting and `git diff --check` passed.
- The Go unit, PostgreSQL integration, recovery, and concurrency tests were independently reviewed and approved for code correctness.
- Runtime Go verification is blocked: the host provides Go 1.25.1 while the repository pins 1.27.1, and the environment returns HTTP 403 for toolchain and `pgx` downloads. Consequently `worker/go.sum` could not be generated here. A connected pinned-toolchain environment must run `go mod tidy`, commit `worker/go.sum`, then run `go test ./...`, `go test -race ./...`, and the worker Docker build before merge.

## Independent review

Review found and drove fixes for Core timer ownership, frozen-clock leases, stale-worker ABA, lost-lease fencing, durable provider idempotency, trace continuity, concurrent batch startup, retry scheduling, real `SKIP LOCKED` coverage, failpoint recovery, strict configuration, and fixture reset. Final review approved the code with no Critical or Important correctness findings; the missing checksum/runtime verification remains an explicit environment blocker.

Commit subject: feat: add go timer and outbox lease worker
