import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../apps/core/package.json', import.meta.url));
const { Pool } = require('pg');

const migrationId = '001_init';
const migrationPath = fileURLToPath(new URL('../apps/core/migrations/001_init.sql', import.meta.url));

function databaseUrl() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return process.env.DATABASE_URL;
}

export async function migrate(connectionString = databaseUrl()) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'kplus:migrations-and-fixture-reset'
    ]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`
    );
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migrationId]);
    if (applied.rowCount === 0) {
      await client.query(await readFile(migrationPath, 'utf8'));
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migrationId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
