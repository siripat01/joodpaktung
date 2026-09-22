import { randomUUID } from 'node:crypto';
import { ledgerEntries } from './schema.js';
import type { DatabaseTransaction } from './pool.js';
import { assertBalanced, type LedgerPosting } from '../domain/ledger.js';

export type LedgerEntryToAppend = {
  readonly orderId: string;
  readonly transactionId: string;
  readonly posting: LedgerPosting;
};

export async function appendLedgerEntries(
  transaction: DatabaseTransaction,
  entries: readonly LedgerEntryToAppend[]
): Promise<void> {
  const postingsByTransaction = new Map<string, LedgerPosting[]>();
  for (const entry of entries) {
    const postings = postingsByTransaction.get(entry.transactionId) ?? [];
    postings.push(entry.posting);
    postingsByTransaction.set(entry.transactionId, postings);
  }
  for (const postings of postingsByTransaction.values()) {
    assertBalanced(postings);
  }

  if (entries.length === 0) return;

  await transaction.insert(ledgerEntries).values(
    entries.map((entry) => ({
      id: randomUUID(),
      orderId: entry.orderId,
      transactionId: entry.transactionId,
      account: entry.posting.account,
      amountSatang: BigInt(entry.posting.amountSatang)
    }))
  );
}
