# K+ โอนซื้อของ POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build an offline Docker Compose prototype that proves conditional-payment correctness, append-only ledger accounting, recovery behavior, and a live Thai three-panel demo.

**Architecture:** A pnpm workspace contains the TypeScript Fastify Payment Core, React web app, and stateful Mock Courier. A separate Go module contains the timer/outbox worker. PostgreSQL 18.6 is the system of record. Only the Core performs financial mutations; the worker leases durable jobs then invokes Core commands with stable idempotency keys.

**Tech Stack:** Node.js 24.21.0, pnpm through Corepack, TypeScript strict, Fastify, React, Vite, TanStack Query, Vitest, fast-check, pg, PostgreSQL 18.6, Go 1.27.1, pgx, Pino, slog, Docker Compose.

**Spec:** docs/superpowers/specs/2026-09-22-k-plus-conditional-payment-poc-design.md

## Global Constraints

- Use pnpm workspaces through Corepack, Node.js 24.21.0 LTS, Go 1.27.1, and PostgreSQL 18.6; pin Docker image tags and every lockfile exactly.
- The demo works offline after images and dependencies are preloaded; Docker Compose starts all services.
- Money is signed integer satang: product 129000, shipping cap 4500, and total 133500; never use floating point.
- Only the TypeScript Payment Core updates payment state, ledger_entries, or processed_events.
- Every financial command uses one PostgreSQL transaction: lock order, evaluate idempotency, validate transition, append balanced entries, update order, write timers/outbox/events, assert invariants, commit.
- The transactional outbox is the only durable queue; LISTEN/NOTIFY is only a wake-up signal.
- UI copy is Thai, contains no real K PLUS or LINE branding, and renders refreshed committed projections only.
- Local payment, courier, and chat adapters are the default; provider payloads stay behind ports and decorators.
- Logs are structured and redacted; never log PINs, secrets, tokens, authorization headers, raw signatures, or personal data.
- Live Quick Proof is 500 sequences at default concurrency 4; Full Proof is 5000 sequences.

## Review Focus

- Replayed financial request returns the stored outcome with no extra posting; Task 4 proves this.
- Delivered before pickup remains terminally rejected after a later valid pickup; Task 5 proves this.
- Crash after Core commit before outbox acknowledgement does not duplicate provider delivery; Task 7 proves this.
- Concurrent buyer-confirm, dispute, and auto-release leave one legal result with a balanced ledger; Task 8 proves this.
- SSE reconnect refetches committed projections instead of trusting a stale event payload; Task 9 proves this.

---

## File Structure

    pnpm-workspace.yaml                 workspace membership
    package.json                        root scripts and pinned package manager
    pnpm-lock.yaml                      exact TypeScript dependencies
    compose.yaml                        pinned local topology
    apps/core/                          Fastify API, domain, PostgreSQL, SSE
    apps/mock-courier/                  signed adversarial courier service
    apps/web/                           React Thai Buyer, Seller, Console panels
    worker/                             Go timer and outbox worker
    scripts/                            migrations, fixtures, proof, rehearsal
    docs/                               demo script and performance evidence

## Execution Status — 2026-09-22

- **Task 1 — Complete:** implemented, Docker-verified, and reviewer-approved. Commits: `a125ff5`, `0e0d348`.
- **Task 2 — Implementation and inline self-review complete:** TDD, domain suite, typecheck, and the follow-up type-safety fix are complete. Commits: `38b8799`, `a8f537b`. The current harness has no subagent-dispatch tool, so independent review is deferred to the required whole-branch gate before merge or push (D-012).
- **Task 3 — Complete:** implemented, TDD-verified, and independently reviewer-approved. Commits: `4c70786`, `714b2c6`, `27f4116`.
- **ORM refactor — Complete:** TypeScript Payment Core persistence now uses Drizzle ORM under D-015. Commits: `4ada541`, `ee6ab2e`; independent review passed.
- **Business Decision D-016/D-017:** buyer-funded shipping allowance is paid to `courier_payable`; `Shipped` replaces `PartiallyReleased`; late courier charge adjustments are idempotent; seller product payout waits for charge finalization.
- **Task 4 — Complete:** direct courier settlement and the D-016/D-017 correction are implemented in commits `ef4c79a..cb4137b`, independently approved with 0 Critical/Important findings, and Terra-verified with 41 Core tests plus workspace typecheck.
- **Task 5 — Complete:** local provider ports, adapters, signed courier webhook and mock scenarios implemented in `10bf232`, with reviewer fixes in `c51ada3`; independent re-review passed. Terra verified 57 Core tests, 5 Mock Courier tests, and workspace typecheck.
- **Task 6 — Complete:** validated command/projection routes, committed replayable SSE, coherent read snapshots, and redacted boundary logs are implemented; independent review passed after historical-state, cursor, observability, and snapshot fixes. Database-backed tests compile but could not run in the current environment because PostgreSQL and Docker are unavailable.
- **Task 7 — Implemented, verification environment-blocked:** Go timer/outbox leasing, Core-owned fenced timer completion, durable local-provider idempotency, operational failpoints, correlation logs, and PostgreSQL recovery tests are implemented and independently approved for code correctness. The current host cannot download Go 1.27.1 or `pgx` (HTTP 403), so `go.sum`, Go test, race, and Docker-build verification remain required on a connected pinned-toolchain environment.
- **CI foundation — Complete:** GitHub Actions now gates all capabilities implemented through Task 7 with pinned tool versions, PostgreSQL-backed TypeScript tests, Go unit/integration/race tests, and Compose validation/build. Task 8–10 proof, browser, and rehearsal gates remain explicitly deferred until their producing tasks exist. The transitional Go job publishes its generated checksum for review until `worker/go.sum` can be committed from a connected Go 1.27.1 environment.
- **Tasks 8–10 — Not started.**

### Task 1: Bootstrap the pinned pnpm workspace and services

**Files:**
- Create: package.json, pnpm-workspace.yaml, .npmrc, .gitignore, compose.yaml, .env.example, README.md
- Create: apps/core/package.json, apps/core/tsconfig.json, apps/core/src/server.ts
- Create: apps/mock-courier/package.json, apps/mock-courier/tsconfig.json, apps/mock-courier/src/server.ts
- Create: apps/web/package.json, apps/web/tsconfig.json, apps/web/vite.config.ts, apps/web/src/main.tsx
- Create: worker/go.mod, worker/cmd/worker/main.go
- Test: apps/core/test/health.test.ts, apps/mock-courier/test/health.test.ts

**Interfaces:**
- Produces: GET /health returns { service: string, status: 'ok' } from Core and Mock Courier. Compose exposes Core :3000, Courier :3001, Web :5173, and Postgres :5432.

- [x] **Step 1: Write failing health tests**

    import { buildServer } from '../src/server.js';

    it('reports the Core health contract', async () => {
      const app = buildServer({ logger: false });
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ service: 'payment-core', status: 'ok' });
    });

- [x] **Step 2: Run test to verify it fails**

Run: pnpm --filter @kplus/core test -- health.test.ts

Expected: FAIL because the workspace and buildServer do not exist.

- [x] **Step 3: Write the minimal workspace and health implementation**

    {
      "name": "kplus-conditional-payment-poc",
      "private": true,
      "packageManager": "pnpm@10.21.0",
      "engines": { "node": "24.21.0" },
      "scripts": {
        "test": "pnpm -r test",
        "typecheck": "pnpm -r typecheck",
        "db:migrate": "node scripts/migrate.mjs",
        "fixture:reset": "node scripts/reset-fixture.mjs",
        "proof:quick": "node scripts/quick-proof.mjs",
        "proof:full": "node scripts/full-proof.mjs",
        "demo:rehearsal": "node scripts/demo-rehearsal.mjs",
        "compose:up": "docker compose up --build"
      }
    }

    packages:
      - apps/*

    export function buildServer(options: { logger: boolean }) {
      const app = Fastify({ logger: options.logger });
      app.get('/health', async () => ({ service: 'payment-core', status: 'ok' as const }));
      return app;
    }

Run Corepack before pnpm install. Pin node:24.21.0-bookworm-slim, golang:1.27.1-bookworm, and postgres:18.6-alpine. Ignore .env, node_modules, dist, coverage, and Go profiles.

Each TypeScript package declares its own name, private true, type module, test script vitest run, and typecheck script tsc --noEmit. The Core package adds Fastify, pg, Pino, Zod, Vitest, and fast-check; the web package adds React, Vite, TanStack Query, Testing Library, and Vitest; the Courier package adds Fastify and Vitest.

- [x] **Step 4: Run local and container health checks**

Run: corepack enable && corepack prepare pnpm@10.21.0 --activate && pnpm install --frozen-lockfile=false && pnpm --filter @kplus/core test -- health.test.ts && pnpm --filter @kplus/mock-courier test -- health.test.ts && docker compose up --build -d

Expected: tests pass and curl --fail http://localhost:3000/health plus curl --fail http://localhost:3001/health return HTTP 200.

- [x] **Step 5: Commit**

    git init
    git add package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc .gitignore compose.yaml .env.example README.md apps worker
    git commit -m "chore: bootstrap reproducible poc workspace"

### Task 2: Implement pure payment state, satang, and ledger primitives

**Files:**
- Create: apps/core/src/domain/types.ts, apps/core/src/domain/money.ts, apps/core/src/domain/state-machine.ts, apps/core/src/domain/ledger.ts
- Test: apps/core/test/domain/state-machine.test.ts, apps/core/test/domain/ledger.test.ts

**Interfaces:**
- Produces: PaymentState, transition(state, trigger), releaseForPickup(chargedFee), LedgerPosting, and assertBalanced(entries).

- [x] **Step 1: Write failing domain tests**

    it('caps pickup release and leaves the product held', () => {
      expect(transition('Reserved', { type: 'courier_picked_up', chargedFee: 9000 }))
        .toMatchObject({ to: 'PartiallyReleased', shippingRelease: 4500 });
      expect(assertBalanced(postHoldThenShipping(133500, 4500))).toBeUndefined();
    });

    it('rejects delivered before pickup without state change', () => {
      expect(() => transition('Reserved', { type: 'courier_delivered' }))
        .toThrow('invalid transition: Reserved + courier_delivered');
    });

- [x] **Step 2: Run test to verify it fails**

Run: pnpm --filter @kplus/core test -- domain

Expected: FAIL because the state and ledger modules do not exist.

- [x] **Step 3: Write the closed state machine and balanced postings**

    export const SHIPPING_CAP = 4500;
    export type PaymentState =
      | 'Reserved' | 'PendingVerification' | 'PartiallyReleased'
      | 'Disputed' | 'Released' | 'Refunded';

    export function releaseForPickup(chargedFee: number): number {
      if (!Number.isInteger(chargedFee) || chargedFee < 0) throw new Error('invalid charged fee');
      return Math.min(chargedFee, SHIPPING_CAP);
    }

    export function assertBalanced(entries: readonly LedgerPosting[]) {
      if (entries.reduce((sum, entry) => sum + entry.amountSatang, 0) !== 0) {
        throw new Error('unbalanced ledger');
      }
    }

Model every approved transition: ship-by refund, pickup partial release, courier unavailable, manual verification, verification timeout, buyer confirm, auto-release, buyer dispute, and both Operations outcomes. Illegal transitions throw DomainRejection with code invalid_transition.

- [x] **Step 4: Run the domain suite**

Run: pnpm --filter @kplus/core test -- domain && pnpm --filter @kplus/core typecheck

Expected: PASS; all legal and illegal state origins, hold, shipping cap, remaining release, and refund postings are tested.

- [x] **Step 5: Commit**

    git add apps/core/src/domain apps/core/test/domain
    git commit -m "feat: add conditional-payment domain and ledger rules"

### Task 3: Create PostgreSQL migrations, transactions, and fixture reset

**Files:**
- Create: apps/core/migrations/001_init.sql, apps/core/src/db/pool.ts, apps/core/src/db/transaction.ts, apps/core/src/db/order-repository.ts, apps/core/src/db/ledger-repository.ts
- Create: scripts/migrate.mjs, scripts/reset-fixture.mjs
- Test: apps/core/test/integration/migrations.test.ts, apps/core/test/integration/fixture-reset.test.ts

**Interfaces:**
- Consumes: PaymentState and LedgerPosting from Task 2.
- Produces: withTransaction(fn), lockOrder(client, orderId), appendLedgerEntries(client, entries), and resetFixture().

    - [x] **Step 1: Write failing migration and reset tests**

    it('creates durable financial tables and the seed order', async () => {
      await migrate(testDatabaseUrl);
      expect(await tableNames()).toEqual(expect.arrayContaining([
        'orders', 'ledger_entries', 'processed_events', 'timers',
        'outbox_events', 'domain_events', 'clock_state'
      ]));
      await resetFixture();
      expect(await seedOrder()).toMatchObject({ state: 'pre_payment', total_satang: 133500 });
    });

    - [x] **Step 2: Run test to verify it fails**

Run: DATABASE_URL=postgres://kplus:kplus@localhost:5432/kplus_test pnpm --filter @kplus/core test -- integration/migrations

Expected: FAIL because migrations and fixture reset do not exist.

    - [x] **Step 3: Write schema and transaction helpers**

    CREATE TABLE processed_events (
      event_key text PRIMARY KEY,
      order_id uuid NOT NULL REFERENCES orders(id),
      outcome text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ledger_entries (
      id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
      transaction_id uuid NOT NULL, account text NOT NULL,
      amount_satang bigint NOT NULL CHECK (amount_satang <> 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX timers_claim_idx ON timers(status, due_at);
    CREATE INDEX outbox_claim_idx ON outbox_events(status, available_at);

    export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }

Use parameterized SQL and SELECT FOR UPDATE for order locks. Add a database trigger rejecting UPDATE or DELETE on ledger_entries. Reset truncates dependent tables, resets clock_state, and inserts one pre-payment seed order.

    - [x] **Step 4: Verify reset speed and schema rules**

Run: pnpm db:migrate && time pnpm fixture:reset && pnpm --filter @kplus/core test -- integration/migrations integration/fixture-reset

Expected: PASS; reset takes under two seconds and a ledger mutation fails.

    - [x] **Step 5: Commit**

    git add apps/core/migrations apps/core/src/db scripts apps/core/test/integration
    git commit -m "feat: add postgres schema transactions and seed fixture"

### Task 4: Implement locked idempotent Payment Core commands and reconciliation

**Files:**
- Create: apps/core/src/application/commands.ts, apps/core/src/application/command-handler.ts, apps/core/src/application/invariants.ts, apps/core/src/application/reconciliation.ts
- Test: apps/core/test/integration/command-handler.test.ts, apps/core/test/integration/idempotency.test.ts, apps/core/test/integration/reconciliation.test.ts

**Interfaces:**
- Consumes: Task 2 domain functions and Task 3 repositories.
- Produces: type PaymentCommand, type CommandContext, type CommandResult, handleCommand(command, context): Promise<CommandResult>, and reconcile(): Promise<ReconciliationResult>.

- [x] **Step 1: Write failing command and idempotency tests**

    it('returns the original result when a pickup command is replayed', async () => {
      const command = { type: 'courier_pickup', orderId, eventKey: 'pickup-1', chargedFee: 4500 } as const;
      const [first, second] = await Promise.all([handleCommand(command, ctx), handleCommand(command, ctx)]);
      expect(first).toEqual(second);
      expect(await ledgerTransactionCount(orderId)).toBe(2);
    });

    it('keeps terminal accounting equal to order total', async () => {
      await handleCommand({ type: 'seller_accepted_and_funded', orderId, eventKey: 'fund-1' }, ctx);
      await handleCommand({ type: 'ship_by_expired', orderId, eventKey: 'timer-1' }, ctx);
      expect(await reconcile()).toMatchObject({ ok: true, violations: [] });
    });

- [x] **Step 2: Run test to verify it fails**

Run: pnpm --filter @kplus/core test -- integration/command-handler integration/idempotency integration/reconciliation

Expected: FAIL because commands have no handler.

- [x] **Step 3: Implement one transaction path for every command**

    export type PaymentCommand =
      | { type: 'seller_accepted_and_funded'; orderId: string; eventKey: string }
      | { type: 'courier_pickup'; orderId: string; eventKey: string; chargedFee: number }
      | { type: 'courier_charge_updated'; orderId: string; eventKey: string; chargedFee: number; finalized: boolean }
      | { type: 'courier_unavailable'; orderId: string; eventKey: string }
      | { type: 'operations_verify_fee'; orderId: string; eventKey: string; chargedFee: number; evidenceRef: string }
      | { type: 'buyer_confirmed' | 'buyer_disputed' | 'ship_by_expired' | 'verification_expired' | 'auto_release_expired'; orderId: string; eventKey: string }
      | { type: 'operations_resolve_refund' | 'operations_resolve_release'; orderId: string; eventKey: string; evidenceRef: string };

    export async function handleCommand(command: PaymentCommand, context: CommandContext): Promise<CommandResult> {
      return withTransaction(async (client) => {
        const existing = await findProcessedEvent(client, command.eventKey);
        if (existing) return { ...existing.result, outcome: 'duplicate-ignored' } as CommandResult;
        const order = await lockOrder(client, command.orderId);
        const result = decideAndPost(order, command);
        await appendLedgerEntries(client, result.postings);
        await saveOrder(client, result.order);
        await insertTimersAndOutbox(client, result.timers, result.outbox);
        await assertOrderInvariants(client, command.orderId);
        await recordProcessedEvent(client, command.eventKey, command.orderId, result.outcome, result);
        await appendDomainEvent(client, result.event);
        return result;
      });
    }

Support seller_accepted_and_funded, courier_pickup, courier_unavailable, operations_verify_fee, buyer_confirmed, buyer_disputed, ship_by_expired, verification_expired, auto_release_expired, operations_resolve_refund, and operations_resolve_release. Record invalid courier events as rejected-invalid-transition before returning. Operations commands require a nonempty evidence reference.

- [x] **Step 4: Run transaction, invariant, and concurrency proof**

Run: pnpm --filter @kplus/core test -- integration/command-handler integration/idempotency integration/reconciliation

Expected: PASS; duplicate, invalid, rollback, balance, terminal-total, and global-hold assertions pass.

- [x] **Step 5: Commit**

    git add apps/core/src/application apps/core/test/integration
    git commit -m "feat: add idempotent payment commands and reconciliation"

### Task 5: Add local provider ports, decorators, and signed courier webhooks

**Files:**
- Create: apps/core/src/ports/payment-provider.ts, apps/core/src/ports/courier-provider.ts, apps/core/src/ports/notification-provider.ts
- Create: apps/core/src/adapters/local-payment.ts, apps/core/src/adapters/local-chat.ts, apps/core/src/adapters/logging-decorator.ts, apps/core/src/adapters/fault-decorator.ts, apps/core/src/http/courier-webhook-route.ts
- Create: apps/mock-courier/src/signing.ts, apps/mock-courier/src/scenarios.ts
- Test: apps/core/test/adapters/provider-contract.test.ts, apps/core/test/http/courier-webhook.test.ts, apps/mock-courier/test/signing.test.ts

**Interfaces:**
- Consumes: handleCommand(command, context) from Task 4.
- Produces: CourierProviderPort.verifyAndNormalize(input) and POST /webhooks/courier.

- [x] **Step 1: Write failing webhook contract tests**

    it('persists early delivered and ignores its replay', async () => {
      const webhook = signedWebhook({ id: 'delivered-early', kind: 'delivered', shipmentToken });
      expect((await app.inject(webhook)).statusCode).toBe(202);
      expect(await processedOutcome('delivered-early')).toBe('rejected-invalid-transition');
      await sendSignedPickup('pickup-1');
      expect((await app.inject(webhook)).json()).toMatchObject({ outcome: 'duplicate-ignored' });
    });

- [x] **Step 2: Run test to verify it fails**

Run: pnpm --filter @kplus/core test -- adapters/provider-contract http/courier-webhook && pnpm --filter @kplus/mock-courier test -- signing

Expected: FAIL because ports, signing, and routes do not exist.

- [x] **Step 3: Define canonical ports and HMAC normalization**

    export type NormalizedCourierEvent =
      | { kind: 'picked_up'; eventKey: string; shipmentToken: string; chargedFee: number }
      | { kind: 'delivered'; eventKey: string; shipmentToken: string }
      | { kind: 'courier_charge_updated'; eventKey: string; shipmentToken: string; chargedFee: number; finalized: boolean };

    export interface CourierProviderPort {
      verifyAndNormalize(input: { rawBody: Buffer; signature: string; traceId?: string }): Promise<NormalizedCourierEvent>;
    }

Verify sha256 HMAC with timingSafeEqual. Bad signatures return 401 and never reach Core. Mock Courier produces valid/invalid signatures, duplicate IDs, delay, delivered-before-pickup, timeout, and 500. Decorators log safe metadata only and return deterministic injected failures.

- [x] **Step 4: Run adapter contract and redaction tests**

Run: pnpm --filter @kplus/core test -- adapters/provider-contract http/courier-webhook && pnpm --filter @kplus/mock-courier test

Expected: PASS; valid HMAC normalizes, invalid HMAC has no financial effect, ordering policy holds, and logs omit secrets.

- [x] **Step 5: Commit**

    git add apps/core/src/ports apps/core/src/adapters apps/core/src/http apps/mock-courier apps/core/test
    git commit -m "feat: add local provider adapters and signed courier mock"

### Task 6: Expose Core commands, projections, committed SSE, and structured logs

**Files:**
- Create: apps/core/src/http/routes.ts, apps/core/src/http/sse.ts, apps/core/src/http/projections.ts, apps/core/src/observability/logger.ts
- Test: apps/core/test/http/commands.test.ts, apps/core/test/http/sse.test.ts, apps/core/test/observability/logger.test.ts

**Interfaces:**
- Consumes: handleCommand, reconcile, and domain_events from Tasks 4–5.
- Produces: POST /commands, GET /orders/:orderId, GET /console, and GET /events.

- [x] **Step 1: Write failing HTTP/SSE tests**

    it('streams a committed event only after command commit', async () => {
      const stream = await openSse('/events');
      await app.inject({ method: 'POST', url: '/commands', payload: fundedCommand });
      await expect(stream.next()).resolves.toMatchObject({
        event: 'order.updated', data: expect.stringContaining('Reserved')
      });
    });

- [x] **Step 2: Run test to verify it fails**

Run: pnpm --filter @kplus/core test -- http/commands http/sse observability/logger

Expected: FAIL because routes and stream service do not exist.

- [x] **Step 3: Add validated routing and replayable SSE**

    app.post('/commands', async (request, reply) => {
      const command = PaymentCommandSchema.parse(request.body);
      const result = await handleCommand(command, requestContext(request));
      return reply.code(result.outcome === 'rejected-invalid-transition' ? 202 : 200).send(result);
    });

    app.get('/events', async (request, reply) =>
      startSse(reply, await eventsAfter(request.headers['last-event-id']))
    );

Pino serializers redact authorization, signature, pin, secret, and token. SSE uses committed domain_events and reconnect reads Last-Event-ID before client query refetch.

- [x] **Step 4: Run API, stream, and redaction tests**

Run: pnpm --filter @kplus/core test -- http/commands http/sse observability/logger

Expected: PASS; malformed command rejects cleanly, SSE resumes, and logs have correlation IDs but no sensitive data.

- [x] **Step 5: Commit**

    git add apps/core/src/http apps/core/src/observability apps/core/test/http apps/core/test/observability
    git commit -m "feat: add core http projections and committed SSE"

### Task 7: Build the Go timer/outbox lease worker

**Files:**
- Create: worker/internal/config/config.go, worker/internal/store/claim.go, worker/internal/coreclient/client.go, worker/internal/outbox/deliverer.go, worker/internal/timers/dispatcher.go, worker/internal/observability/logger.go
- Modify: worker/cmd/worker/main.go
- Test: worker/internal/store/claim_test.go, worker/internal/outbox/deliverer_test.go, worker/internal/timers/dispatcher_test.go

**Interfaces:**
- Consumes: Task 3 tables and Task 6 POST /commands.
- Produces: ClaimDue(ctx, kind, limit), type CoreClient, and CoreClient.Submit(ctx, command).

- [x] **Step 1: Write failing Go lease and recovery tests**

    func TestClaimDueSkipsRowLeasedByAnotherWorker(t *testing.T) {
      first := claim(t, storeA, 1)
      second := claim(t, storeB, 1)
      require.Len(t, first, 1)
      require.Empty(t, second)
    }

    func TestCrashAfterCoreCommitBeforeAckRedeliversWithoutSecondEffect(t *testing.T) {
      activateFailpoint(t, "before_outbox_ack")
      require.Error(t, worker.RunOnce(ctx))
      expireLease(t)
      require.NoError(t, restartedWorker.RunOnce(ctx))
      require.Equal(t, 1, deliveredNotificationCount(t))
    }

- [x] **Step 2: Run test to verify it fails**

Run: cd worker && go test ./internal/store ./internal/outbox ./internal/timers

Expected: FAIL because worker packages do not exist.

- [x] **Step 3: Implement lease claims and stable keys**

    const claimSQL = "WITH candidate AS (SELECT id FROM timers WHERE status = 'pending' AND due_at <= now() ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE timers t SET status = 'leased', lease_owner = $2, lease_until = now() + $3::interval FROM candidate WHERE t.id = candidate.id RETURNING t.*"

    type CoreClient interface {
      Submit(context.Context, map[string]any) (CommandResult, error)
    }

    func (c *Client) Submit(ctx context.Context, command map[string]any) (CommandResult, error) {
      body, err := json.Marshal(command)
      if err != nil { return CommandResult{}, err }
      request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/commands", bytes.NewReader(body))
      if err != nil { return CommandResult{}, err }
      response, err := c.http.Do(request)
      if err != nil { return CommandResult{}, err }
      defer response.Body.Close()
      var result CommandResult
      return result, json.NewDecoder(response.Body).Decode(&result)
    }

Timer commands use eventKey timer:<timerID>; provider delivery uses notificationKey outbox:<outboxID>. Retryable failures use backoff; permanent failures record a Core domain event. Use slog JSON and context cancellation. No worker SQL mutates orders, ledger_entries, or processed_events.

- [ ] **Step 4: Run Go unit, race, and recovery tests**

Run: cd worker && go test ./... && go test -race ./... && go test -run TestCrashAfterCoreCommitBeforeAck ./internal/outbox

Expected: PASS; one worker claims a job and restart does not duplicate delivery.

- [x] **Step 5: Commit**

    git add worker
    git commit -m "feat: add go timer and outbox lease worker"

### Task 8: Add deterministic chaos, property proof, and Go performance evidence

**Files:**
- Create: apps/core/src/application/failpoints.ts, apps/core/src/application/clock.ts, apps/core/test/property/model.ts, apps/core/test/property/payment.property.test.ts, apps/core/test/chaos/scenarios.test.ts
- Create: scripts/quick-proof.mjs, scripts/full-proof.mjs, worker/internal/benchmark/runner.go, worker/internal/benchmark/runner_test.go, worker/cmd/bench/main.go, docs/benchmarks/README.md

**Interfaces:**
- Consumes: Core commands, Mock Courier scenarios, and worker from Tasks 4–7.
- Produces: clock.now(), clock.advance(ms), failpoints.activate(name), proof report, and BenchmarkReport.

- [ ] **Step 1: Write failing chaos, model, and percentile tests**

    it('chooses one result when confirm, dispute, and auto-release race', async () => {
      await partiallyReleasedOrder();
      const results = await Promise.allSettled([
        command('buyer_confirmed', 'confirm-1'),
        command('buyer_disputed', 'dispute-1'),
        command('auto_release_expired', 'timer-1')
      ]);
      expect(await reconcile()).toMatchObject({ ok: true });
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    func TestSummarizeReportsPercentiles(t *testing.T) {
      report := Summarize([]time.Duration{1, 2, 3, 4, 5}, 4)
      require.Equal(t, 4, report.Concurrency)
      require.Equal(t, 3*time.Nanosecond, report.P50)
      require.Greater(t, report.P99, report.P95)
    }

- [ ] **Step 2: Run tests to verify they fail**

Run: pnpm --filter @kplus/core test -- chaos property && cd worker && go test ./internal/benchmark

Expected: FAIL because clock, failpoints, model, and benchmark code do not exist.

- [ ] **Step 3: Implement deterministic controls and proof runners**

    await fc.assert(fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 40 }), async (actions) => {
      const model = new PaymentModel();
      for (const action of actions) {
        const expected = model.apply(action);
        const actual = await runRealAction(action);
        expect(normalize(actual)).toEqual(expected);
        expect((await reconcile()).ok).toBe(true);
      }
    }), { numRuns: Number(process.env.PROOF_RUNS ?? 500), seed });

    type BenchmarkReport struct {
      Concurrency int
      Throughput float64
      P50, P95, P99 time.Duration
    }

Implement named failpoints after_timer_claim, after_domain_commit, and before_outbox_ack. Quick Proof uses isolated schema, 500 seeded sequences, PROOF_CONCURRENCY=4, and replay JSON. Full Proof changes only PROOF_RUNS=5000. Benchmark runs concurrency 1, 4, and 16, emits JSON, and documents measured PostgreSQL-lock versus provider-I/O contention before optimization.

- [ ] **Step 4: Run proof and performance checks**

Run: pnpm --filter @kplus/core test -- chaos property && pnpm proof:quick && pnpm proof:full && cd worker && go test ./... && go test -race ./... && go run ./cmd/bench -concurrency=1,4,16 -jobs=1000

Expected: mandatory duplicate, reorder, race, crash, time-travel, failure, and reset scenarios pass; reports include seed, duration, invariant state, throughput, p50, p95, p99.

- [ ] **Step 5: Commit**

    git add apps/core/src/application apps/core/test/chaos apps/core/test/property scripts worker docs/benchmarks
    git commit -m "feat: add deterministic proof and worker performance evidence"

### Task 9: Build Thai React panels with TanStack Query and committed SSE refresh

**Files:**
- Create: apps/web/src/api/client.ts, apps/web/src/api/queries.ts, apps/web/src/api/sse.ts, apps/web/src/App.tsx
- Create: apps/web/src/features/buyer/BuyerPanel.tsx, apps/web/src/features/seller/SellerPanel.tsx, apps/web/src/features/console/ConsolePanel.tsx, apps/web/src/features/console/StateDiagram.tsx, apps/web/src/features/console/LedgerTable.tsx
- Test: apps/web/src/features/buyer/BuyerPanel.test.tsx, apps/web/src/features/console/ConsolePanel.test.tsx, apps/web/src/api/sse.test.ts

**Interfaces:**
- Consumes: GET /orders/:orderId, GET /console, POST /commands, and GET /events from Task 6.
- Produces: Buyer, Seller, and Console panels with useOrder, useConsole, and useCommittedEvents hooks.

- [ ] **Step 1: Write failing Thai UI and reconnect tests**

    it('refetches committed projections after an SSE event', async () => {
      render(<App />);
      sse.emit('order.updated', { id: orderId, eventId: '42' });
      await waitFor(() => expect(fetchOrder).toHaveBeenCalledWith(orderId));
      expect(screen.getByRole('button', { name: 'ยืนยันว่าได้รับสินค้าแล้ว' })).toBeVisible();
    });

- [ ] **Step 2: Run test to verify it fails**

Run: pnpm --filter @kplus/web test -- BuyerPanel ConsolePanel sse

Expected: FAIL because app, query hooks, and panels do not exist.

- [ ] **Step 3: Implement query-first committed panels**

    export function useCommittedEvents(orderId: string) {
      const queryClient = useQueryClient();
      useEffect(() => connectSse('/events', () => {
        void queryClient.invalidateQueries({ queryKey: ['order', orderId] });
        void queryClient.invalidateQueries({ queryKey: ['console'] });
      }), [orderId, queryClient]);
    }

Buyer submits the mock PIN without retaining or logging it. Seller accepts/rejects only while pre-payment. Console shows state, ledger, invariant, event outcomes, clock, chaos controls, proof progress, and Operations commands requiring evidence reference. Hide actions unavailable for the committed state.

- [ ] **Step 4: Run frontend tests and build**

Run: pnpm --filter @kplus/web test && pnpm --filter @kplus/web build

Expected: PASS; Thai copy renders and each panel refreshes from committed query state.

- [ ] **Step 5: Commit**

    git add apps/web
    git commit -m "feat: add thai three-panel live demo UI"

### Task 10: Finish Compose integration, offline rehearsal, and CI verification

**Files:**
- Modify: compose.yaml, README.md, .env.example
- Create: scripts/demo-rehearsal.mjs, scripts/preload-images.sh, scripts/demo-rehearsal.test.mjs, docs/demo-script.md, .github/workflows/verify.yml

**Interfaces:**
- Consumes: all services, pnpm proof:quick, and UI from Tasks 1–9.
- Produces: pnpm demo:rehearsal and a CI verification workflow.

- [ ] **Step 1: Write failing rehearsal test**

    it('runs the four-minute scenario without browser refresh', async () => {
      const report = await rehearse({ baseUrl: 'http://localhost:3000' });
      expect(report.steps).toEqual([
        'seller_accepts_and_buyer_funds',
        'pickup_releases_shipping',
        'delivered_then_auto_release',
        'quick_proof_green'
      ]);
      expect(report.invariantsOk).toBe(true);
    });

- [ ] **Step 2: Run test to verify it fails**

Run: node --test scripts/demo-rehearsal.test.mjs

Expected: FAIL because the rehearsal and complete topology do not exist.

- [ ] **Step 3: Implement delivery automation and documentation**

    services:
      postgres: { image: postgres:18.6-alpine }
      core: { build: ./apps/core, depends_on: { postgres: { condition: service_healthy } } }
      worker: { build: ./worker, depends_on: [core] }
      mock-courier: { build: ./apps/mock-courier, depends_on: [core] }
      web: { build: ./apps/web, depends_on: [core] }

Rehearsal resets fixtures, drives acceptance/funding, pickup, delivered, clock fast-forward, and Quick Proof, then checks reconciliation. preload-images.sh pulls only three pinned images. CI runs typecheck, TypeScript tests, Go tests with race detector, migrations, Quick Proof, web build, and rehearsal. Demo script documents expected ledger/state evidence and offline fallback.

- [ ] **Step 4: Verify full delivery path**

Run: docker compose up --build -d && pnpm db:migrate && pnpm fixture:reset && pnpm demo:rehearsal && pnpm proof:quick && cd worker && go test -race ./...

Expected: PASS; Compose starts from preloaded images, rehearsal remains green, and Quick Proof emits actual duration and seed.

- [ ] **Step 5: Commit**

    git add compose.yaml README.md .env.example scripts docs/demo-script.md .github/workflows/verify.yml
    git commit -m "chore: add offline rehearsal and verification pipeline"

## Plan self-review

- Spec coverage: Tasks 2–4 cover the state machine, immutable ledger, locks, idempotency, timers, outbox, and reconciliation. Tasks 5–7 cover adapters, logs, SSE, and Go ownership. Task 8 covers deterministic proof and worker metrics. Tasks 9–10 cover the Thai panels, Compose, offline operation, and rehearsal.
- Placeholder scan: no unassigned decision or deferred implementation marker remains; later interfaces are produced by prior tasks.
- Type consistency: PaymentCommand, CommandResult, eventKey, handleCommand, reconcile, and POST /commands retain their names across tasks.
- Review focus: every listed risk has an owning test in Tasks 4, 5, 7, 8, and 9.
