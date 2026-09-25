# Implementation handoff (2026-09-25)

Branch: `codex/implement-poc-plan`. Base: `5166b08` (Task 5 complete).

## Task 6 progress

- Added validated `POST /commands`, `GET /orders/:orderId`, and `GET /console` projections.
- Added replayable `/events` SSE. A migration assigns monotonic sequence numbers to committed domain events. An advisory transaction lock keeps sequence assignment in commit order; clients use `Last-Event-ID` to replay.
- The command route strips the mock PIN before calling the Payment Core and returns safe errors. Logs do not include bodies or secrets.
- Added HTTP validation, SSE replay, and log redaction tests.

## Verified here

`apps/core/node_modules/.bin/tsc --noEmit -p apps/core/tsconfig.json` passes.

`apps/core/node_modules/.bin/vitest run apps/core/test/domain apps/core/test/adapters apps/core/test/http/commands.test.ts apps/core/test/http/sse.test.ts apps/core/test/observability/logger.test.ts apps/core/test/health.test.ts --config apps/core/vitest.config.ts` passes: 28 tests across seven files.

## Required before Task 6 can be marked complete

This execution environment does not provide PostgreSQL, Go, or Docker. Existing PostgreSQL integration tests fail with `ECONNREFUSED localhost:5432`; they were not changed. Run migration `003_domain_event_sequence.sql` against PostgreSQL, then test command persistence, rollback, console projection, SSE after a real commit, concurrent commit order, and reconnect replay. Run the full Core suite and typecheck with the repository's pinned Node/pnpm versions. Tasks 7–10 of `docs/superpowers/plans/2026-09-22-k-plus-conditional-payment-poc.md` remain unstarted.
