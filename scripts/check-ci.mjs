import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const document = parse(workflow);

assert.ok(document.on.pull_request !== undefined);
assert.deepEqual(document.on.push.branches, ['main']);
assert.equal(document.permissions.contents, 'read');
assert.equal(document.concurrency['cancel-in-progress'], true);
assert.deepEqual(Object.keys(document.jobs).sort(), ['compose', 'typescript', 'worker']);
assert.equal(document.env.NODE_VERSION, '24.21.0');
assert.equal(document.env.PNPM_VERSION, '10.21.0');
assert.equal(document.env.GO_VERSION, '1.27.1');

const steps = Object.fromEntries(
  Object.entries(document.jobs).map(([job, value]) => [
    job,
    value.steps.map((step) => step.run ?? step.uses)
  ])
);
const namedSteps = Object.fromEntries(
  Object.entries(document.jobs).map(([job, value]) => [
    job,
    Object.fromEntries(value.steps.filter((step) => step.name).map((step) => [step.name, step]))
  ])
);
assert.ok(steps.typescript.includes('actions/checkout@v4.2.2'));
assert.ok(steps.typescript.includes('actions/setup-node@v4.4.0'));
assert.ok(steps.worker.includes('actions/setup-go@v5.5.0'));
assert.ok(steps.worker.includes('actions/upload-artifact@v4.6.2'));
assert.ok(document.jobs.typescript.services.postgres.options.includes('pg_isready'));
assert.equal(document.jobs.typescript.services.postgres.image, 'postgres:18.6-alpine');
assert.equal(document.jobs.typescript.steps[2].with.cache, 'pnpm');
assert.equal(document.jobs.typescript.steps[2].with['cache-dependency-path'], 'pnpm-lock.yaml');
assert.equal(document.jobs.worker.steps[3].with.cache, false);
assert.match(namedSteps.typescript['Install locked dependencies'].run, /pnpm install --frozen-lockfile/);
assert.match(namedSteps.typescript['Apply migrations and reset fixture'].run, /pnpm db:migrate/);
assert.match(namedSteps.typescript['Apply migrations and reset fixture'].run, /pnpm fixture:reset/);
assert.equal(namedSteps.typescript['Typecheck workspace'].run, 'pnpm typecheck');
assert.equal(namedSteps.typescript['Test workspace'].run, 'pnpm test');
assert.match(namedSteps.worker['Resolve and verify worker modules'].run, /go mod tidy/);
assert.equal(namedSteps.worker['Test worker'].run, 'go test ./...');
assert.equal(namedSteps.worker['Race-test worker'].run, 'go test -race ./...');
assert.equal(namedSteps.compose['Validate Compose model'].run, 'docker compose config --quiet');
assert.equal(namedSteps.compose['Build pinned service images'].run, 'docker compose build');

for (const required of [
  'node-version: ${{ env.NODE_VERSION }}',
  'go-version: ${{ env.GO_VERSION }}',
  'image: postgres:18.6-alpine',
  'pnpm install --frozen-lockfile',
  'pnpm db:migrate',
  'pnpm fixture:reset',
  'pnpm typecheck',
  'pnpm test',
  'go mod tidy',
  'go mod verify',
  'go test ./...',
  'go test -race ./...',
  'docker compose config --quiet',
  'docker compose build'
]) {
  assert.ok(workflow.includes(required), `CI workflow is missing: ${required}`);
}

for (const deferred of ['proof:quick', 'proof:full', 'demo:rehearsal', 'playwright']) {
  assert.ok(!workflow.includes(deferred), `CI must not claim the deferred gate yet: ${deferred}`);
}

assert.match(workflow, /NODE_VERSION: 24\.21\.0/);
assert.match(workflow, /PNPM_VERSION: 10\.21\.0/);
assert.match(workflow, /GO_VERSION: 1\.27\.1/);
assert.match(workflow, /--health-cmd "pg_isready -U kplus -d kplus_test"/);

console.log('CI workflow contract is valid for Tasks 1-7.');
