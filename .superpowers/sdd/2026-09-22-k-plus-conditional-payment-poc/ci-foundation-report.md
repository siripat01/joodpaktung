# CI Foundation Handoff

Status: COMPLETE_WITH_TRANSITIONAL_GO_CHECKSUM

## Delivery

Added a least-privilege GitHub Actions workflow for capabilities implemented through Task 7. Separate jobs verify TypeScript/PostgreSQL behavior, the Go worker including race tests, and the Docker Compose model/build. Tool and service versions are exact, PostgreSQL jobs use health checks, pnpm installs are frozen and cached, and redundant runs on the same ref are cancelled.

The repository also has a parsed-YAML CI contract check and documentation for current versus deferred gates. D-019 binds the incremental approach: Quick/Full Proof, browser smoke, and rehearsal are added only with Tasks 8–10 rather than represented by placeholder green checks.

## Transitional Go checksum handling

`worker/go.sum` cannot be generated in the current environment because the pinned Go toolchain/module downloads return HTTP 403. The workflow therefore disables setup-go caching, resolves and verifies modules with Go 1.27.1, rejects `go.mod` drift, runs tests and race tests, and publishes the generated checksum plus patch for review. This is explicitly not described as a locked state. The checksum must be reviewed and committed, then checksum drift enforcement and Go caching enabled in the same follow-up.

## Verification

- The CI checker has valid JavaScript syntax.
- The updated pnpm lock validates offline with a frozen lockfile.
- Core, Mock Courier, and Web package-local TypeScript checks pass.
- Ruby's YAML parser successfully reads the workflow and confirms all three jobs exist.
- `git diff --check` passes.
- Final independent review approved with no Critical or Important findings.

Commit subject: ci: add verification pipeline for current capabilities
