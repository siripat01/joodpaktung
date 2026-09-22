# Coding Agent Entry Point

This repository is a greenfield proof of concept for **K+ โอนซื้อของ**.

Before changing product code, read the documents in this order:

1. `docs/ai-sdlc/README.md`
2. `docs/ai-sdlc/01-business-requirements.md`
3. `docs/ai-sdlc/02-architecture.md`
4. `docs/ai-sdlc/04-data-and-correctness.md`
5. `docs/ai-sdlc/05-testing-and-chaos.md`
6. `docs/ai-sdlc/09-provider-adapters-and-observability.md`
7. `docs/ai-sdlc/07-decisions-and-open-questions.md`
8. `docs/ai-sdlc/10-autonomous-decisions.md`

Non-negotiable rules:

- PostgreSQL ledger entries are append-only and are the money source of truth.
- Only the TypeScript Payment Core may change an order state, write ledger entries, or record processed events.
- Every money-affecting command is idempotent and runs in one database transaction.
- Go workers may claim/deliver jobs but must call the Payment Core for timer-driven state transitions.
- Provider-specific API payloads must stay behind a port/adapter; domain code uses canonical internal commands and events only.
- Every meaningful boundary writes a structured, redacted log with correlation IDs. Do not log PINs, HMAC secrets, tokens, raw signatures, or personal data.
- Do not silently invent a state transition, a refund policy, or an event-ordering policy. Terra records its selected safe POC decision in `10-autonomous-decisions.md`; stop only for an irreversible external action, real money/credentials, a material scope expansion, or a conflict with an explicit product rule.
- Write tests before or alongside every domain change. A green UI never substitutes for a green invariant.

This document is an entry point; the documents under `docs/ai-sdlc/` are the product specification.
