import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { appendLedgerEntries } from '../db/ledger-repository.js';
import { lockOrder, type LockedOrder } from '../db/order-repository.js';
import { withTransaction } from '../db/transaction.js';
import { postHold, postProductRelease, postRefund, postShippingRelease } from '../domain/ledger.js';
import { transition, type PaymentTrigger } from '../domain/state-machine.js';
import { DomainRejection } from '../domain/types.js';
import type { CommandContext, CommandResult, PaymentCommand } from './commands.js';
import { assertOrderInvariants } from './invariants.js';

function evidenceRequired(command: PaymentCommand): void {
  if ((command.type === 'operations_verify_fee' || command.type === 'operations_resolve_refund' || command.type === 'operations_resolve_release') && !command.evidenceRef.trim()) {
    throw new Error('evidenceRef is required');
  }
}

function triggerFor(command: PaymentCommand): PaymentTrigger {
  switch (command.type) {
    case 'courier_pickup': return { type: 'courier_picked_up', chargedFee: command.chargedFee };
    case 'operations_verify_fee': return { type: command.type, chargedFee: command.chargedFee };
    default: return { type: command.type } as PaymentTrigger;
  }
}

function publicOrder(order: LockedOrder) {
  return { id: order.id, state: order.state, shipping_released_satang: order.shipping_released_satang, product_released_satang: order.product_released_satang, refunded_satang: order.refunded_satang };
}

async function saveOrder(client: PoolClient, orderId: string, state: string, shipping: number, product: number, refunded: number): Promise<LockedOrder> {
  const result = await client.query<LockedOrder>(
    `UPDATE orders SET state = $2, shipping_released_satang = $3, product_released_satang = $4,
            refunded_satang = $5, updated_at = now() WHERE id = $1
       RETURNING id, shipment_token, state, product_satang, shipping_cap_satang, total_satang,
                 shipping_released_satang, product_released_satang, refunded_satang,
                 ship_by, verification_deadline, dispute_deadline, created_at, updated_at`,
    [orderId, state, shipping, product, refunded]
  );
  return result.rows[0]!;
}

async function schedule(client: PoolClient, order: LockedOrder, kind: string, dueAt: Date | null, eventKey: string, payload: Record<string, unknown>): Promise<void> {
  if (!dueAt) return;
  await client.query(
    `INSERT INTO timers (id, order_id, kind, due_at, event_key, payload) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_key) DO NOTHING`, [randomUUID(), order.id, kind, dueAt, `timer:${eventKey}:${kind}`, payload]
  );
}

async function persistOutcome(client: PoolClient, command: PaymentCommand, result: CommandResult): Promise<void> {
  await client.query(
    `INSERT INTO processed_events (event_key, order_id, outcome, result) VALUES ($1, $2, $3, $4)`,
    [command.eventKey, command.orderId, result.outcome, result]
  );
  await client.query(
    `INSERT INTO domain_events (id, order_id, event_name, payload) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), command.orderId, command.type, { eventKey: command.eventKey, outcome: result.outcome, releasedSatang: result.releasedSatang ?? 0 }]
  );
  await client.query(
    `INSERT INTO outbox_events (id, order_id, kind, notification_key, payload) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (notification_key) DO NOTHING`,
    [randomUUID(), command.orderId, command.type, `event:${command.eventKey}`, { eventKey: command.eventKey, outcome: result.outcome }]
  );
}

export async function handleCommand(command: PaymentCommand, context: CommandContext): Promise<CommandResult> {
  evidenceRequired(command);
  context.logger?.info({ event: 'command_received', trace_id: context.traceId, request_id: context.requestId, order_id: command.orderId, event_key: command.eventKey, outcome: 'received' });
  return withTransaction(async (client) => {
    const order = await lockOrder(client, command.orderId);
    const existing = await client.query<{ result: CommandResult }>('SELECT result FROM processed_events WHERE event_key = $1', [command.eventKey]);
    if (existing.rows[0]) return existing.rows[0].result;

    let next: LockedOrder = order;
    let releasedSatang = 0;
    let postings = [] as { orderId: string; transactionId: string; posting: { account: 'buyer_available' | 'hold_suspense' | 'seller_available' | 'buyer_refund'; amountSatang: number } }[];
    const transactionId = randomUUID();
    try {
      if (command.type === 'seller_accepted_and_funded') {
        if (order.state !== 'pre_payment') throw new DomainRejection('Reserved', command.type);
        postings = postHold(Number(order.total_satang)).map((posting) => ({ orderId: order.id, transactionId, posting }));
        next = await saveOrder(client, order.id, 'Reserved', 0, 0, 0);
        await schedule(client, order, 'ship_by_expired', order.ship_by, command.eventKey, {});
      } else {
        const result = transition(order.state as Exclude<typeof order.state, 'pre_payment'>, triggerFor(command));
        if (result.shippingRelease !== undefined) {
          releasedSatang = Math.min(result.shippingRelease, Number(order.shipping_cap_satang), Number(order.total_satang) - Number(order.shipping_released_satang) - Number(order.product_released_satang) - Number(order.refunded_satang));
          postings = postShippingRelease(releasedSatang).map((posting) => ({ orderId: order.id, transactionId, posting }));
        } else if (result.to === 'Released') {
          releasedSatang = Number(order.total_satang) - Number(order.shipping_released_satang) - Number(order.product_released_satang) - Number(order.refunded_satang);
          postings = postProductRelease(releasedSatang).map((posting) => ({ orderId: order.id, transactionId, posting }));
        } else if (result.to === 'Refunded') {
          releasedSatang = Number(order.total_satang) - Number(order.shipping_released_satang) - Number(order.product_released_satang) - Number(order.refunded_satang);
          postings = postRefund(releasedSatang).map((posting) => ({ orderId: order.id, transactionId, posting }));
        }
        const shipping = Number(order.shipping_released_satang) + (result.shippingRelease !== undefined ? releasedSatang : 0);
        const product = Number(order.product_released_satang) + (result.to === 'Released' ? releasedSatang : 0);
        const refunded = Number(order.refunded_satang) + (result.to === 'Refunded' ? releasedSatang : 0);
        next = await saveOrder(client, order.id, result.to, shipping, product, refunded);
        if (result.to === 'PendingVerification') await schedule(client, order, 'verification_expired', order.verification_deadline, command.eventKey, {});
        if (result.to === 'PartiallyReleased') await schedule(client, order, 'auto_release_expired', order.dispute_deadline, command.eventKey, {});
      }
      await appendLedgerEntries(client, postings);
      const result: CommandResult = { outcome: 'processed', order: publicOrder(next), event: { name: command.type, eventKey: command.eventKey }, ...(releasedSatang ? { releasedSatang } : {}) };
      await assertOrderInvariants(client, command.orderId);
      await persistOutcome(client, command, result);
      return result;
    } catch (error) {
      if (!(error instanceof DomainRejection)) throw error;
      const result: CommandResult = { outcome: 'rejected-invalid-transition', order: publicOrder(order), event: { name: command.type, eventKey: command.eventKey } };
      await persistOutcome(client, command, result);
      return result;
    }
  });
}

export type { CommandContext, CommandResult, PaymentCommand } from './commands.js';
