import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { appendLedgerEntries } from '../db/ledger-repository.js';
import { lockOrder, saveOrder, type LockedOrder } from '../db/order-repository.js';
import { domainEvents, outboxEvents, processedEvents, timers } from '../db/schema.js';
import { withTransaction, type DatabaseTransaction } from '../db/transaction.js';
import { postHold, postProductRelease, postRefund, postShippingRelease } from '../domain/ledger.js';
import { transition, type PaymentTrigger } from '../domain/state-machine.js';
import { DomainRejection } from '../domain/types.js';
import type { CommandContext, CommandResult, PaymentCommand } from './commands.js';
import { assertOrderInvariants } from './invariants.js';

function logCommand(
  context: CommandContext,
  command: PaymentCommand,
  event: string,
  outcome: string,
  startedAt: number,
  extra: Record<string, unknown> = {}
): void {
  context.logger?.info({
    event,
    trace_id: context.traceId,
    request_id: context.requestId,
    order_id: command.orderId,
    event_key: command.eventKey,
    outcome,
    duration_ms: Date.now() - startedAt,
    ...extra
  });
}

function evidenceRequired(command: PaymentCommand): void {
  if (
    (command.type === 'operations_verify_fee' ||
      command.type === 'operations_resolve_refund' ||
      command.type === 'operations_resolve_release') &&
    !command.evidenceRef.trim()
  ) {
    throw new Error('evidenceRef is required');
  }
}

function triggerFor(command: PaymentCommand): PaymentTrigger {
  switch (command.type) {
    case 'courier_pickup':
      return { type: 'courier_picked_up', chargedFee: command.chargedFee };
    case 'operations_verify_fee':
      return { type: command.type, chargedFee: command.chargedFee };
    default:
      return { type: command.type } as PaymentTrigger;
  }
}

function publicOrder(order: LockedOrder) {
  return {
    id: order.id,
    state: order.state,
    shipping_released_satang: order.shipping_released_satang,
    product_released_satang: order.product_released_satang,
    refunded_satang: order.refunded_satang
  };
}

function safeNumber(value: bigint): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) throw new Error('satang amount exceeds safe integer range');
  return numberValue;
}

function remainingSatang(order: LockedOrder): bigint {
  return (
    BigInt(order.total_satang) -
    BigInt(order.shipping_released_satang) -
    BigInt(order.product_released_satang) -
    BigInt(order.refunded_satang)
  );
}

async function schedule(
  transaction: DatabaseTransaction,
  order: LockedOrder,
  kind: string,
  dueAt: Date | null,
  eventKey: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!dueAt) return;
  await transaction
    .insert(timers)
    .values({
      id: randomUUID(),
      orderId: order.id,
      kind,
      dueAt,
      eventKey: `timer:${eventKey}:${kind}`,
      payload
    })
    .onConflictDoNothing({ target: timers.eventKey });
}

async function persistOutcome(
  transaction: DatabaseTransaction,
  command: PaymentCommand,
  result: CommandResult
): Promise<void> {
  await transaction.insert(processedEvents).values({
    eventKey: command.eventKey,
    orderId: command.orderId,
    outcome: result.outcome,
    result
  });
  await transaction.insert(domainEvents).values({
    id: randomUUID(),
    orderId: command.orderId,
    eventName: command.type,
    payload: {
      eventKey: command.eventKey,
      outcome: result.outcome,
      releasedSatang: result.releasedSatang ?? 0,
      ...('evidenceRef' in command ? { evidenceRef: command.evidenceRef } : {})
    }
  });
  await transaction
    .insert(outboxEvents)
    .values({
      id: randomUUID(),
      orderId: command.orderId,
      kind: command.type,
      notificationKey: `event:${command.eventKey}`,
      payload: { eventKey: command.eventKey, outcome: result.outcome }
    })
    .onConflictDoNothing({ target: outboxEvents.notificationKey });
}

export async function handleCommand(command: PaymentCommand, context: CommandContext): Promise<CommandResult> {
  const startedAt = Date.now();
  try {
    evidenceRequired(command);
  } catch (error) {
    context.logger?.error?.({
      event: 'command_rejected',
      trace_id: context.traceId,
      request_id: context.requestId,
      order_id: command.orderId,
      event_key: command.eventKey,
      outcome: 'rejected-invalid-input',
      duration_ms: Date.now() - startedAt,
      error_type: error instanceof Error ? error.name : 'unknown'
    });
    throw error;
  }
  logCommand(context, command, 'command_received', 'received', startedAt);

  try {
    const result = await withTransaction(async (transaction) => {
      const order = await lockOrder(transaction, command.orderId);
      logCommand(context, command, 'order_lock_acquired', 'acquired', startedAt);
      const existing = await transaction
        .select({ result: processedEvents.result })
        .from(processedEvents)
        .where(eq(processedEvents.eventKey, command.eventKey))
        .limit(1);
      if (existing[0]) {
        return { ...(existing[0].result as CommandResult), outcome: 'duplicate-ignored' as const };
      }

      let next = order;
      let releasedSatang = 0;
      let postings: {
        orderId: string;
        transactionId: string;
        posting: {
          account: 'buyer_available' | 'hold_suspense' | 'seller_available' | 'buyer_refund';
          amountSatang: number;
        };
      }[] = [];
      const transactionId = randomUUID();

      try {
        if (command.type === 'seller_accepted_and_funded') {
          if (order.state !== 'pre_payment') throw new DomainRejection('Reserved', command.type);
          postings = postHold(safeNumber(BigInt(order.total_satang))).map((posting) => ({
            orderId: order.id,
            transactionId,
            posting
          }));
          await appendLedgerEntries(transaction, postings);
          next = await saveOrder(transaction, order.id, 'Reserved', 0n, 0n, 0n);
          await schedule(transaction, order, 'ship_by_expired', order.ship_by, command.eventKey, {});
        } else {
          const result = transition(order.state as Exclude<typeof order.state, 'pre_payment'>, triggerFor(command));
          const currentShipping = BigInt(order.shipping_released_satang);
          const currentProduct = BigInt(order.product_released_satang);
          const currentRefunded = BigInt(order.refunded_satang);
          const remaining = remainingSatang(order);

          if (result.shippingRelease !== undefined) {
            const shippingRelease = [
              BigInt(result.shippingRelease),
              BigInt(order.shipping_cap_satang),
              remaining
            ].reduce((minimum, value) => (value < minimum ? value : minimum));
            releasedSatang = safeNumber(shippingRelease);
            postings = postShippingRelease(releasedSatang).map((posting) => ({
              orderId: order.id,
              transactionId,
              posting
            }));
            await appendLedgerEntries(transaction, postings);
            next = await saveOrder(
              transaction,
              order.id,
              result.to,
              currentShipping + shippingRelease,
              currentProduct,
              currentRefunded
            );
          } else if (result.to === 'Released') {
            releasedSatang = safeNumber(remaining);
            postings = postProductRelease(releasedSatang).map((posting) => ({
              orderId: order.id,
              transactionId,
              posting
            }));
            await appendLedgerEntries(transaction, postings);
            next = await saveOrder(
              transaction,
              order.id,
              result.to,
              currentShipping,
              currentProduct + remaining,
              currentRefunded
            );
          } else if (result.to === 'Refunded') {
            releasedSatang = safeNumber(remaining);
            postings = postRefund(releasedSatang).map((posting) => ({
              orderId: order.id,
              transactionId,
              posting
            }));
            await appendLedgerEntries(transaction, postings);
            next = await saveOrder(
              transaction,
              order.id,
              result.to,
              currentShipping,
              currentProduct,
              currentRefunded + remaining
            );
          } else {
            next = await saveOrder(
              transaction,
              order.id,
              result.to,
              currentShipping,
              currentProduct,
              currentRefunded
            );
          }

          if (result.to === 'PendingVerification') {
            await schedule(transaction, order, 'verification_expired', order.verification_deadline, command.eventKey, {});
          }
          if (result.to === 'PartiallyReleased') {
            await schedule(transaction, order, 'auto_release_expired', order.dispute_deadline, command.eventKey, {});
          }
        }

        if (postings.length) {
          logCommand(context, command, 'ledger_posted', 'posted', startedAt, { posting_count: postings.length });
        }
        const result: CommandResult = {
          outcome: 'processed',
          order: publicOrder(next),
          event: { name: command.type, eventKey: command.eventKey },
          ...(releasedSatang ? { releasedSatang } : {})
        };
        await assertOrderInvariants(transaction, command.orderId);
        logCommand(context, command, 'invariant_passed', 'passed', startedAt);
        await persistOutcome(transaction, command, result);
        return result;
      } catch (error) {
        if (!(error instanceof DomainRejection)) throw error;
        const result: CommandResult = {
          outcome: 'rejected-invalid-transition',
          order: publicOrder(order),
          event: { name: command.type, eventKey: command.eventKey }
        };
        await assertOrderInvariants(transaction, command.orderId);
        logCommand(context, command, 'invariant_passed', 'passed', startedAt);
        await persistOutcome(transaction, command, result);
        return result;
      }
    });
    if (result.outcome === 'duplicate-ignored') {
      logCommand(context, command, 'command_deduplicated', result.outcome, startedAt);
    } else if (result.outcome === 'rejected-invalid-transition') {
      logCommand(context, command, 'command_rejected', result.outcome, startedAt);
    } else {
      logCommand(context, command, 'command_committed', result.outcome, startedAt);
    }
    return result;
  } catch (error) {
    context.logger?.error?.({
      event: 'command_rolled_back',
      trace_id: context.traceId,
      request_id: context.requestId,
      order_id: command.orderId,
      event_key: command.eventKey,
      outcome: 'rolled_back',
      duration_ms: Date.now() - startedAt,
      error_type: error instanceof Error ? error.name : 'unknown'
    });
    throw error;
  }
}

export type { CommandContext, CommandResult, PaymentCommand } from './commands.js';
