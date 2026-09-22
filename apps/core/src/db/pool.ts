import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgTransaction } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

let sharedPool: Pool | undefined;
let sharedDatabase: Database | undefined;

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return databaseUrl;
}

export function getPool(): Pool {
  sharedPool ??= new Pool({ connectionString: getDatabaseUrl() });
  return sharedPool;
}

export function getDatabase(): Database {
  sharedDatabase ??= drizzle(getPool(), { schema });
  return sharedDatabase;
}

export async function closePool(): Promise<void> {
  await sharedPool?.end();
  sharedPool = undefined;
  sharedDatabase = undefined;
}
