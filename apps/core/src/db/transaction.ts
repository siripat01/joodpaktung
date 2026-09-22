import { getDatabase, type DatabaseTransaction } from './pool.js';

export type { DatabaseTransaction } from './pool.js';

export async function withTransaction<T>(fn: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  return getDatabase().transaction(fn);
}
