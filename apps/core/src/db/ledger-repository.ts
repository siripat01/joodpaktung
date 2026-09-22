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
  assertBalanced(entries.map((entry) => entry.posting));

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
