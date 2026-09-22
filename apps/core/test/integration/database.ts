import { Pool } from 'pg';

export const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://kplus:kplus@localhost:5432/kplus_test';

export async function ensureTestDatabase(): Promise<void> {
  const url = new URL(databaseUrl);
  const name = url.pathname.slice(1);
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error('test database name must contain only letters, numbers, and underscores');
  }

  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString() });
  try {
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [name]);
    const exists = await admin.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [name]
    );
    if (!exists.rows[0]?.exists) {
      await admin.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [name]).catch(() => undefined);
    await admin.end();
  }
}
