# Task 5 Handoff

Status: DONE_WITH_CONCERNS

## Delivery

Implemented the Task 5 provider ports and local adapters, redacted logging and deterministic fault decorators, SHA-256 HMAC courier normalization, and `POST /webhooks/courier`. Signed pickup, delivered, and charge-update evidence maps to the Task 4 canonical commands. Invalid/missing signatures are rejected before Payment Core; recognized courier outcomes return HTTP 202, preserving terminal rejection and duplicate semantics. Mock Courier scenario fixtures generate valid/invalid signatures, duplicate and reordered deliveries, delay metadata, and deterministic timeout/500 outcomes.

D-016/D-017 remain unchanged. No Task 6 commands, projections, or SSE were added. The raw provider payload and signature stay outside Payment Core and logs; lookup and signature verification happen before `handleCommand` opens its transaction.

## RED evidence

- `DATABASE_URL=postgres://kplus:kplus@localhost:5432/kplus_test NPM_CONFIG_ENGINE_STRICT=false pnpm --filter @kplus/core test -- adapters/provider-contract http/courier-webhook`: failed on the expected missing fault-decorator and courier-provider modules; 41 pre-existing tests passed.
- `NPM_CONFIG_ENGINE_STRICT=false pnpm --filter @kplus/mock-courier test -- signing`: failed on the expected missing signing module; 2 pre-existing tests passed.
- Scenario-generation test failed with `createScenarioDeliveries is not a function` before the helper was added.
- Missing-signature contract test failed with expected HTTP 401, received 400 before the route correction.
- Fault-decorator log contract failed because no `provider_fault_injected` record was emitted before logging was added.

## GREEN verification

- `DATABASE_URL=postgres://kplus:kplus@localhost:5432/kplus_test NPM_CONFIG_ENGINE_STRICT=false pnpm test` — exit 0. Core: 11 files / 52 tests passed. Mock Courier: 2 files / 5 tests passed. Web package: no test files, accepted by `--passWithNoTests`.
- `NPM_CONFIG_ENGINE_STRICT=false pnpm typecheck` — exit 0 for Core, Mock Courier, and Web.
- `NPM_CONFIG_ENGINE_STRICT=false pnpm --filter @kplus/mock-courier test -- signing` — exit 0 after scenario helper implementation: 2 files / 5 tests passed.
- Final full verification ran after the last source and test edits.

## Files

- Core ports: `apps/core/src/ports/{payment-provider,courier-provider,notification-provider}.ts`.
- Core adapters: `apps/core/src/adapters/{local-payment,local-chat,logging-decorator,fault-decorator}.ts`.
- Webhook route and wiring: `apps/core/src/http/courier-webhook-route.ts`, `apps/core/src/server.ts`, `compose.yaml`, `.env.example`.
- Mock Courier helpers: `apps/mock-courier/src/{signing,scenarios}.ts`.
- Tests: `apps/core/test/adapters/provider-contract.test.ts`, `apps/core/test/http/courier-webhook.test.ts`, `apps/mock-courier/test/signing.test.ts`.

## Self-review and concerns

- Confirmed the webhook logger and decorators omit raw bodies, signatures, HMAC secrets, and shipment tokens. The webhook only passes normalized canonical commands to Payment Core. The early delivered test confirms its event key is retained as `rejected-invalid-transition` and replayed as `duplicate-ignored`; signed reweigh verifies one append-only fee adjustment.
- Per the explicit task instruction, implementation and review were done solo; no independent Reviewer was used.
- Host Node is v24.15.0 while the repository pins v24.21.0. Commands used `NPM_CONFIG_ENGINE_STRICT=false`; pnpm emitted the engine mismatch warning, but full tests and typecheck exited 0.
- No `.orig` or `.rej` patch artifacts remain, and `AGENTS.md` remains unstaged and untouched by this task.

Commit subject: feat: add local provider adapters and signed courier mock


## Review fix round 1 (base `10bf232`)

Addressed the Important fault-outcome finding and the Minor trace-correlation finding. Result-returning provider faults now return canonical `timeout` or `retryable_failure` outcomes (including the required notification ID); courier verification faults throw typed `CourierWebhookError` failures, and the webhook maps them to a redacted HTTP 503 response without recording or applying an event. The route now creates and carries a single trace ID through provider verification, webhook logging, and Payment Core. No money rules or other task scope changed.

### Test files

- `apps/core/test/adapters/provider-contract.test.ts`: result-port timeout/HTTP 500 outcomes, notification ID preservation, typed courier failures, explicit correlation ID preservation.
- `apps/core/test/http/courier-webhook.test.ts`: transient courier failure mapping/no financial event, redaction, and same trace ID across verification/route/Core.

### RED evidence

Command:

```sh
DATABASE_URL=postgres://kplus:kplus@localhost:5432/kplus_test NPM_CONFIG_ENGINE_STRICT=false pnpm --filter @kplus/core test -- adapters/provider-contract http/courier-webhook
```

Output summary: exit 1; 2 test files failed and 9 passed; 5 tests failed and 52 passed. Expected failures: payment and notification faults rejected with `FaultInjectionError`; courier fault was not a typed canonical error; trace IDs differed (two unique IDs); HTTP 500 did not log `retryable_failure`.

### GREEN verification

Focused command:

```sh
DATABASE_URL=postgres://kplus:kplus@localhost:5432/kplus_test NPM_CONFIG_ENGINE_STRICT=false pnpm --filter @kplus/core test -- adapters/provider-contract http/courier-webhook
```

Output: exit 0; 11 test files passed, 57 tests passed (Vitest ran the full Core suite for this filter invocation).

Core typecheck:

```sh
NPM_CONFIG_ENGINE_STRICT=false pnpm --filter @kplus/core typecheck
```

Output: exit 0; `tsc --noEmit` completed successfully.

Full workspace verification:

```sh
DATABASE_URL=postgres://kplus:kplus@localhost:5432/kplus_test NPM_CONFIG_ENGINE_STRICT=false pnpm test && NPM_CONFIG_ENGINE_STRICT=false pnpm typecheck
```

Output: exit 0. Core: 11 files / 57 tests passed. Mock Courier: 2 files / 5 tests passed. Web: no test files (configured `--passWithNoTests`). Typecheck completed successfully for Core, Web, and Mock Courier. pnpm emitted the known engine warning: repo requests Node `24.21.0`, host is `v24.15.0`; `NPM_CONFIG_ENGINE_STRICT=false` was used as instructed.

The `.orig` artifact reported earlier is absent from this worktree; no untracked patch artifacts were created. `AGENTS.md` remains an existing unrelated modification and was not staged.
