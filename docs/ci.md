# Continuous integration

The GitHub Actions workflow verifies only capabilities delivered through Tasks 1–7. It uses the repository's pinned Node.js, pnpm, Go, and PostgreSQL versions.

## Current required jobs

- **TypeScript and PostgreSQL:** frozen pnpm install, workflow contract check, migrations, fixture reset, workspace typecheck, and all current Vitest suites against a healthy PostgreSQL service.
- **Go worker:** exact Go toolchain check, module resolution and checksum verification, unit/integration tests, and the race detector against PostgreSQL.
- **Container build:** Compose model validation and builds of all pinned service images.

`worker/go.sum` is not currently committed because the pinned toolchain and module proxy were unavailable in the implementation environment. CI therefore runs pinned `go mod tidy`, tests the resolved graph, and publishes the generated checksum plus its patch as the `generated-worker-checksums` artifact. This is transitional and is **not** a locked dependency state. Generate and review `worker/go.sum` with Go 1.27.1 in a connected environment, then commit it; after that, CI rejects any `go.mod` or `go.sum` drift. Never hand-write module hashes.

The setup-go module cache is deliberately disabled during this transition because setup-go restores its cache before the workflow can generate the missing checksum file. Enable setup-go caching, with `worker/go.sum` as its dependency path, only in the same change that commits the reviewed checksum. pnpm caching is already enabled from the committed `pnpm-lock.yaml`.

## Deferred gates

Do not add placeholder green checks. Extend CI only when the corresponding implementation exists:

1. Task 8 adds deterministic Quick Proof (500 sequences), Full Proof (5,000 sequences), replay artifacts, mandatory crash/race scenarios, and worker performance evidence. Full Proof becomes a required CI job then.
2. Task 9 adds browser smoke coverage for the Thai three-panel UI and committed SSE refresh/reconnect behavior.
3. Task 10 adds the timed demo rehearsal, sub-two-second reset check, and offline fallback verification.

Run the static workflow contract locally with `pnpm ci:check`.
