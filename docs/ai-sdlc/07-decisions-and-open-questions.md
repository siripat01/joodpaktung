# Decisions and Decision Register

## Decisions already made

| Topic | Decision |
|---|---|
| Scope | Greenfield hackathon POC, offline-first |
| Durable work queue | PostgreSQL transactional outbox; no external broker |
| Payment authority | TypeScript Payment Core only |
| Go scope | Timer dispatch, outbox delivery, chaos/load tools; no direct money writes |
| Realtime | SSE from committed events |
| Testing | Live Quick Proof 500 sequences plus Full Proof 5,000 sequences |
| Currency | Integer satang |
| Frontend server state | React remains the UI framework; TanStack Query handles server state and mutations |
| Provider integration | Ports/adapters with local mocks by default; no real provider dependency in the offline demo |
| Logging | Structured JSON logs at important boundaries, with redaction and correlation IDs |
| Seller acceptance | Seller accepts before the payment state machine begins; `Reserved` means seller accepted and buyer funding succeeded. Seller rejection cancels only the pre-payment intent. |
| Manual verification | Engineering Console has a demo-only Operations role. It may confirm a courier fee from operational evidence, then submit the normal `PendingVerification -> PartiallyReleased` command. |
| Out-of-order delivered | A `delivered` event before `picked_up` is terminally rejected for that event key. Retries are duplicate-ignored; a corrected event must use a new key after pickup. |
| Refund destination | `buyer_refund` is the final visible refund destination for the POC. No follow-up transfer back to `buyer_available` is modelled. |
| Dispute resolution | The demo-only Engineering Console Operations role resolves both `Disputed -> Refunded` and `Disputed -> Released` through the normal Payment Core command path. |
| Hardware baseline | Assume at least 8 logical CPUs and 16 GB RAM; Quick Proof defaults to concurrency 4 and remains configurable. |
| Future providers | All MVP integrations are local only. No real-provider sandbox spike is scheduled. |

## Autonomous decision policy

There are no known implementation-blocking product questions. The full binding register is [`10-autonomous-decisions.md`](10-autonomous-decisions.md). Terra records any new ordinary POC decision there before code relies on it.

Agents must still stop for an irreversible external action, real money/credentials, material scope expansion, or a conflict with an explicit product rule.
