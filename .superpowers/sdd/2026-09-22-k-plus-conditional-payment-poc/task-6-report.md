# Task 6 Handoff

Status: DONE_WITH_ENVIRONMENT_LIMITATION

## Delivery

Implemented validated Core command routing, committed order and console projections, replayable SSE backed by `domain_events`, and centralized structured logging with redaction. Projection reads use one read-only repeatable-read transaction, including reconciliation, so a response cannot mix financial facts from different snapshots.

SSE persists and replays each event's immutable resulting state, validates reconnect cursors before opening the stream, and logs connection, reconnect, delivery, close, rejection, and failure boundaries with correlation IDs. Duplicate audit events use the currently locked order state rather than the original command result.

## Verification

- Core TypeScript typecheck passed through the package-local compiler.
- 23 focused non-database Core tests passed, covering health, domain rules, provider contracts, and log redaction.
- `git diff --check` passed.
- The new PostgreSQL-backed command, projection, cursor, historical replay, and duplicate-audit tests compile but could not run because this environment has no PostgreSQL service or Docker executable.
- The repository pins Node.js 24.21.0 while the host provides 24.15.0, so package-local binaries were used instead of the pnpm wrapper.

## Independent review

The first review found four Important issues: mutable state in historical SSE replay, stalled invalid cursors, missing SSE boundary logs, and projections spanning inconsistent snapshots. After fixes, re-review found one stale-state edge case in duplicate audit events. That edge case was corrected and covered by a regression test. The final independent review approved the task with no Critical or Important findings.

Commit subject: feat: add core http projections and committed SSE
