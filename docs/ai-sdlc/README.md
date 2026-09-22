# AI-SDLC Handoff: K+ โอนซื้อของ

## Purpose

This folder is the source of planning context for coding agents working on the hackathon proof of concept. It describes the product, correctness constraints, architecture, chosen technology, test proof, delivery order, and outstanding decisions.

The pitch is about proving safe conditional-payment behaviour under duplication, reordering, concurrent commands, and crashes. Visual polish is secondary to money correctness.

## Read order

| Order | Document | Use it for |
|---:|---|---|
| 1 | `01-business-requirements.md` | Product scope and exact state rules |
| 2 | `02-architecture.md` | Component ownership and data flow |
| 3 | `03-tech-stack.md` | Chosen implementation technologies |
| 4 | `04-data-and-correctness.md` | Schema direction, ledger, transactions, invariants |
| 5 | `05-testing-and-chaos.md` | Test pyramid and demo chaos scenarios |
| 6 | `06-delivery-roadmap.md` | Milestone order and definition of done |
| 7 | `07-decisions-and-open-questions.md` | Locked choices and decision register index |
| 8 | `08-agent-workflow.md` | Rules for making safe changes |
| 9 | `09-provider-adapters-and-observability.md` | Mock/real provider boundaries, sandbox research, and logging standard |
| 10 | `10-autonomous-decisions.md` | Terra's binding decisions for ordinary POC ambiguity |

## Current decisions

- Build a greenfield, offline-first Docker Compose POC.
- Use TypeScript for the React frontend and Payment Core.
- Use Go for timer dispatch, outbox delivery, and load/chaos tooling.
- Use PostgreSQL transactional outbox as the durable job queue; do not add RabbitMQ/Kafka for this POC.
- Use two test modes: Live Quick Proof (500 sequences) and Full Proof (5,000 sequences).
- Keep React and add TanStack Query for server-state caching and command mutations.
- Put every KBank/payment, courier, and chat notification integration behind a port/adapter with local mock implementations as the default.
- Write structured, redacted logs at every important system boundary.
- Terra resolves ordinary POC ambiguity and records the result in `10-autonomous-decisions.md` before implementation.

## Scope boundary

In scope: mock roles, mock PIN, mock courier, immutable ledger, state machine, timers, outbox, realtime updates, deterministic chaos, and correctness tests.

Out of scope: KBank/K PLUS integration, real courier/LINE integration, KYC, real authentication, and production-grade security controls.
