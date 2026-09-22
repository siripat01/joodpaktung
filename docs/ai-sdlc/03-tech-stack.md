# Technology Stack

## Selected stack

| Area | Choice | Rationale |
|---|---|---|
| Browser UI | React + Vite + TypeScript strict + TanStack Query | React renders the panels; TanStack Query owns server-state reads, mutations, cache invalidation, and reconnect refetching |
| Payment Core | TypeScript + Fastify | Small HTTP surface, SSE support, and a single language for domain and property tests |
| Database | PostgreSQL | Transactions, row locking, `SKIP LOCKED`, indexes, and durable outbox in one system |
| Database access | `pg` with parameterized SQL and versioned SQL migrations | Explicit control over `FOR UPDATE`, ledger postings, and transaction scope |
| Worker | Go + `pgx` | Practice Go concurrency, context cancellation, profiling, and connection pooling on real background work |
| Realtime | Server-Sent Events | Server-to-browser committed updates without a bidirectional socket protocol |
| Frontend server state | `@tanstack/react-query` | Query snapshots for buyer/seller/console, command mutations, and SSE-triggered cache refresh |
| Property testing | Vitest + fast-check | Stateful model tests, shrinkable failures, seeds, and replay paths |
| Go testing | `go test`, race detector, benchmarks, pprof | Verify worker concurrency and measure CPU, memory, blocking, and throughput |
| Structured logs | Pino (TypeScript) and `log/slog` (Go) | JSON logs with correlation IDs and shared redaction rules |
| Local runtime | Docker Compose | One command starts API, worker, courier, PostgreSQL, and UI |

## Version policy

Pin exact versions in lockfiles and Docker image tags when implementation begins. Use actively supported Node.js and Go releases at that time; do not use floating `latest` image tags.

Use pnpm workspaces through Corepack for the TypeScript packages. Commit `pnpm-lock.yaml`; do not mix npm, Yarn, or Bun lockfiles.

## Operational constraints

- The demo must work offline after images and dependencies have been preloaded.
- Commit package lockfiles and Go module checksums.
- Export or pre-pull Docker images before the live demo.
- Do not add Redis, RabbitMQ, Kafka, or a cloud dependency unless the product owner explicitly changes scope.
- TanStack Query does not replace React; it is the chosen React server-state layer. SSE messages trigger a refetch or targeted cache update from the committed API projection.
