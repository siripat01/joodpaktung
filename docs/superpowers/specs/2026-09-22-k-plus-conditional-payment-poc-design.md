# K+ โอนซื้อของ POC Design

## Intent and success criteria

Build an offline-first, four-week hackathon prototype proving that a conditional social-commerce payment remains correct under duplicate, reordered, delayed, concurrent, and crash-recovered actions. The demo is for judges and engineering reviewers: it must show the buyer, seller, and operations views updating from committed facts without a page refresh, while the console makes ledger and invariant evidence visible.

The product is not a banking, courier, or identity product. All integrations are local mocks, all visible copy is Thai, and no real K PLUS or LINE branding is used. The source of truth for money is an append-only PostgreSQL double-entry ledger, never a mutable balance or an external provider response.

## Scope

The single-page app has three live panels:

- Buyer: starts a payment with a mock PIN, sees its status, confirms receipt, or reports a problem.
- Seller: accepts or rejects the pre-payment intent, receives a system-issued shipment token/label after funding, and sees releases.
- Engineering Console: shows the state diagram, T-account ledger, invariant result, event outcomes, simulated clock, and deterministic chaos/test progress.

The seeded order holds 133500 satang: product 129000 and shipping maximum 4500. Amounts are signed integers in satang. The only payment states are `Reserved`, `PendingVerification`, `PartiallyReleased`, `Disputed`, `Released`, and `Refunded`.

## Architecture and ownership

Use a modular monolith with independently runnable TypeScript API/UI, Go worker, Mock Courier, and PostgreSQL processes under Docker Compose. The TypeScript Payment Core owns commands, state transitions, idempotency records, ledger postings, invariant checks, timer setup, domain events, and transactional outbox records. Every money-affecting command locks the order with `SELECT ... FOR UPDATE`, records or checks its event key, validates state, appends balanced postings, updates order metadata, creates timers/outbox events, verifies invariants, and commits once. No network request occurs in that transaction.

The repository uses pnpm workspaces through Corepack with Node.js 24.21.0 LTS, Go 1.27.1, and PostgreSQL 18.6. Docker image tags and language dependency lockfiles are pinned exactly. This toolchain decision is recorded as D-011 in the Terra decision register.

The Go worker claims due timers and outbox rows using leases and `SKIP LOCKED`. It invokes an internal Payment Core command with a stable idempotency key for timer-driven state transitions; it never updates orders, ledger entries, or processed events directly. PostgreSQL `LISTEN/NOTIFY` may wake a dispatcher but the tables remain the replayable durable queue.

SSE publishes committed domain-event projections. React renders the interface and TanStack Query owns snapshots and mutations; an SSE message triggers targeted query refresh from the committed API projection rather than trusting an optimistic event payload.

## State and financial rules

Seller acceptance happens before funding. Seller rejection only cancels the pre-payment intent and makes no accounting entry. After seller acceptance plus successful funding, `Reserved` holds the full amount in `hold_suspense`.

| Source state | Evidence or command | Target state | Financial effect |
|---|---|---|---|
| Reserved | `ship_by` timer expires | Refunded | Move all remaining hold to `buyer_refund`. |
| Reserved | Valid signed pickup webhook | PartiallyReleased | Move `min(charged_fee, 4500)` from hold to seller. |
| Reserved | Invalid/unavailable courier fee | PendingVerification | Do not release money. |
| PendingVerification | Operations verifies fee and evidence | PartiallyReleased | Release only verified fee, capped at 4500. |
| PendingVerification | verification deadline expires | Refunded | Move all remaining hold to `buyer_refund`. |
| PartiallyReleased | buyer confirms receipt | Released | Move the remaining hold to seller. |
| PartiallyReleased | delivered dispute-window timer expires | Released | Move the remaining hold to seller. |
| PartiallyReleased | buyer reports a problem | Disputed | Leave remaining hold unchanged. |
| Disputed | Operations resolves for buyer | Refunded | Move remaining hold to `buyer_refund`. |
| Disputed | Operations resolves for seller | Released | Move remaining hold to seller. |

A shipment token is issued by the system and bound one-to-one with the order. Seller tracking input is never accepted as a release trigger. The courier fee must come from signed normalized courier data or Operations evidence, never the seller. A delivered webhook before pickup is terminally `rejected-invalid-transition` for its event key; its retries are `duplicate-ignored` and cannot reevaluate it.

## Provider boundaries and observability

Define `PaymentProviderPort`, `CourierProviderPort`, and `NotificationPort` in the core. Local adapters are the Docker Compose default: `LocalPaymentProvider`, a stateful HMAC-signed `MockCourier`, and `LocalChatNotificationProvider`. Logging and deterministic fault-injection decorators wrap either local or future real adapters. Adapters normalize provider responses into canonical values and outcomes; they cannot choose a payment state or amount.

Write JSON logs through Pino in TypeScript and `slog` in Go at HTTP, command, transaction, provider, webhook, worker, outbox, timer, and SSE boundaries. Attach available correlation fields such as `trace_id`, `request_id`, `order_id`, `event_key`, `timer_id`, and `outbox_id`. Never write mock PINs, HMAC secrets, authorization values, raw signatures, tokens, or personal data to logs.

## Correctness and test proof

The accounts are `buyer_available`, `hold_suspense`, `seller_available`, and `buyer_refund`. Each ledger transaction balances to zero. Per-order released-plus-refunded amount never exceeds the order total and equals it in terminal states. Global `hold_suspense` equals the remaining amount across non-terminal orders. An event key can create at most one financial effect. A reconciliation job recalculates these facts from the ledger.

Tests are layered: pure TypeScript state and ledger unit tests; PostgreSQL integration tests for locks, rollback, uniqueness, leases, and outbox; adapter contracts; deterministic chaos; fast-check model tests; Go tests/race/benchmarks; and UI smoke tests. Live Quick Proof executes 500 generated sequences in 30–60 seconds, defaulting to worker concurrency 4; Full Proof executes 5000 in 3–8 minutes. Each uses an isolated database or schema and persists seed, replay path, and minimized failure trace.

Mandatory chaos proof covers duplicate pickup, delivered-before-pickup, concurrent buyer commands and auto-release, worker crash after commit before acknowledgement, simulated-clock time travel, courier timeout/500, and seed reset in under two seconds. Failpoints are named deterministic boundaries, including `after_timer_claim`, `after_domain_commit`, and `before_outbox_ack`.

## Delivery and agent workflow

Build in this order: payment-core schema/state/ledger; worker and local provider integration; chaos/property proof; then the UI and rehearsal. Do not start interactive UI work until core tests are green. Terra decides ordinary POC ambiguities and records them in `docs/ai-sdlc/10-autonomous-decisions.md`. Luna implements one testable task at a time. An independent reviewer checks each task, especially its invariant, lock/idempotency behavior, recovery path, and log redaction.

## Explicit non-goals

Real KBank/K PLUS, courier, LINE, KYC, authentication, cloud infrastructure, Redis, RabbitMQ, Kafka, and production-grade security controls are outside this POC. Do not add a second transfer from `buyer_refund` to `buyer_available`.
