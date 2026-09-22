import { Pool } from 'pg';

let sharedPool: Pool | undefined;

export function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return databaseUrl;
}

export function getPool(): Pool {
  sharedPool ??= new Pool({ connectionString: getDatabaseUrl() });
  return sharedPool;
}

export async function closePool(): Promise<void> {
  await sharedPool?.end();
  sharedPool = undefined;
}
