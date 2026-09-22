import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { assertBalanced, type LedgerPosting } from '../domain/ledger.js';

export type LedgerEntryToAppend = {
  readonly orderId: string;
  readonly transactionId: string;
  readonly posting: LedgerPosting;
};

export async function appendLedgerEntries(
  client: PoolClient,
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

  for (const entry of entries) {
    await client.query(
      `INSERT INTO ledger_entries (id, order_id, transaction_id, account, amount_satang)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        entry.orderId,
        entry.transactionId,
        entry.posting.account,
        entry.posting.amountSatang
      ]
    );
  }
}
