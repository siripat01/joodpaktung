# Terra Autonomous Decisions

## Policy

The product owner has delegated ordinary POC design choices to **Terra**. Terra chooses the smallest safe option that preserves money correctness, documents it here before implementation, and has Luna and the reviewer treat it as binding.

Terra must still stop before an irreversible external action, use of real money or credentials, a material expansion beyond this POC, or a conflict with an explicit product rule. Those cases require explicit product-owner direction.

## Decision register

| ID | Decision | Rationale and effect |
|---|---|---|
| D-001 | Seller acceptance precedes funding. `Reserved` exists only once seller acceptance and buyer funding both succeed. | A rejected offer creates no financial record, hold, or payment state. |
| D-002 | The demo-only Engineering Console **Operations** role can verify a courier fee and resolve disputes. | Operations records an evidence reference and selects either `Disputed -> Refunded` or `Disputed -> Released`; both commands use the same locked, idempotent Payment Core transaction and create audit events. |
| D-003 | A `delivered` courier event before a recorded pickup is terminally rejected for its event key. | This prevents an out-of-order webhook from releasing product money. A retry of that same key is duplicate-ignored; a corrected event needs a new key after pickup. |
| D-004 | `buyer_refund` is the refund's final visible account. | The POC does not model a second transfer into `buyer_available`, keeping terminal accounting and the console T-account clear. |
| D-005 | The MVP uses only local provider adapters. No external sandbox spike is in scope. | The offline demo remains reproducible. KBank, LINE, and courier sandbox research stays reference material for a post-POC decision. |
| D-006 | The target demo profile is a laptop with at least 8 logical CPUs and 16 GB RAM; Quick Proof defaults to concurrency 4. | The value is configurable by environment variable. The app measures and displays actual run time instead of claiming performance that was not measured on the demo machine. |
| D-007 | PostgreSQL transactional outbox is the only durable queue in the MVP. | `LISTEN/NOTIFY` is a wake-up optimization only. RabbitMQ, Kafka, Redis, and cloud queues are out of scope unless the product owner changes it. |
| D-008 | The TypeScript Payment Core alone changes payment state, writes the ledger, or records idempotency outcomes. | Go workers may lease jobs and invoke internal idempotent commands, but cannot directly mutate financial tables. |
| D-009 | Every meaningful boundary emits structured, redacted logs. | Logs are diagnostic only; the append-only ledger and domain events are the durable audit. PINs, secrets, tokens, raw signatures, and personal data are never logged. |
| D-010 | Terra orchestrates work, Luna implements task-sized changes with tests, and an independent reviewer gates each completed task. | This preserves a review boundary for state-machine, ledger, concurrency, and recovery changes. |
| D-011 | Use pnpm workspaces through Corepack, Node.js 24.21.0 LTS, Go 1.27.1, and PostgreSQL 18.6; pin their Docker tags and all dependency lockfiles. | Corepack pins pnpm without a global installation. Node 24 is the current LTS release, Go 1.27.1 is the current stable release, and PostgreSQL 18.6 is the current supported minor release when this decision was made. |

## Decision lifecycle

When a new ambiguity appears, Terra adds a numbered decision with the selected option, rationale, affected files or rules, and date. A later decision may supersede an earlier one only by naming its ID and explaining the migration impact.
