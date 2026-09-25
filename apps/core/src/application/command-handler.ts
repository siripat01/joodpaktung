import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { appendLedgerEntries, type LedgerEntryToAppend } from '../db/ledger-repository.js';
import { lockOrder, saveOrder, type LockedOrder } from '../db/order-repository.js';
import { domainEvents, outboxEvents, processedEvents, timers } from '../db/schema.js';
import { withTransaction, type DatabaseTransaction } from '../db/transaction.js';
import {
  postCourierCharge,
  postCourierChargeAdjustment,
  postProductRelease,
  postRefund,
  postHold,
  type LedgerPosting
} from '../domain/ledger.js';
import { toSatang, type SatangInput } from '../domain/money.js';
import { transition, type PaymentTrigger } from '../domain/state-machine.js';
import { DomainRejection, type PaymentState } from '../domain/types.js';
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

function logInvariantFailure(context: CommandContext, command: PaymentCommand, startedAt: number, error: unknown): void {
  context.logger?.error?.({
    event: 'invariant_failed',
    trace_id: context.traceId,
    request_id: context.requestId,
    order_id: command.orderId,
    event_key: command.eventKey,
    outcome: 'failed',
    duration_ms: Date.now() - startedAt,
    error_type: error instanceof Error ? error.name : 'unknown'
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
    case 'courier_charge_updated':
      return { type: command.type, chargedFee: command.chargedFee, finalized: command.finalized };
    case 'operations_verify_fee':
      return { type: command.type, chargedFee: command.chargedFee };
    default:
      return { type: command.type } as PaymentTrigger;
  }
}

function publicOrder(order: LockedOrder): CommandResult['order'] {
  return {
    id: order.id,
    state: order.state,
    courier_paid_satang: order.courier_paid_satang,
    courier_charge_satang: order.courier_charge_satang,
    courier_charge_finalized: order.courier_charge_finalized,
    delivered_at: order.delivered_at?.toISOString() ?? null,
    product_released_satang: order.product_released_satang,
    refunded_satang: order.refunded_satang
  };
}

const TIMER_COMMAND_TYPES = new Set<PaymentCommand['type']>([
  'ship_by_expired', 'verification_expired', 'auto_release_expired'
]);

async function completeOwnedTimer(transaction: DatabaseTransaction, command: PaymentCommand): Promise<boolean> {
  if (!TIMER_COMMAND_TYPES.has(command.type)) return false;
  if (!('leaseToken' in command) || !command.leaseToken) throw new Error('timer lease token required');
  const completed = await transaction.update(timers)
    .set({ status: 'completed', leaseOwner: null, leaseUntil: null, updatedAt: sql`now()` })
    .where(and(eq(timers.eventKey, command.eventKey), eq(timers.orderId, command.orderId),
      eq(timers.status, 'leased'), eq(timers.leaseOwner, command.leaseToken), sql`${timers.leaseUntil} > now()`))
    .returning({ id: timers.id });
  if (completed.length !== 1) throw new Error('timer lease lost');
  return true;
}

function remainingSatang(order: LockedOrder): bigint {
  return (
    BigInt(order.total_satang) -
    BigInt(order.courier_paid_satang) -
    BigInt(order.product_released_satang) -
    BigInt(order.refunded_satang)
  );
}

function entriesFor(orderId: string, transactionId: string, postings: readonly LedgerPosting[]): LedgerEntryToAppend[] {
  return postings.map((posting) => ({ orderId, transactionId, posting }));
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
      resultingState: result.order.state,
      releasedSatang: result.releasedSatang ?? '0',
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
  if (
    (command.type === 'courier_pickup' ||
      command.type === 'operations_verify_fee' ||
      command.type === 'courier_charge_updated') &&
    result.order.courier_paid_satang !== '0'
  ) {
    await transaction
      .insert(outboxEvents)
      .values({
        id: randomUUID(),
        orderId: command.orderId,
        kind: 'courier_settlement_requested',
        notificationKey: `courier-settlement:${command.eventKey}`,
        payload: {
          eventName: 'CourierSettlementRequested',
          orderId: command.orderId,
          eventKey: command.eventKey,
          courierPaidSatang: result.order.courier_paid_satang,
          finalized: result.order.courier_charge_finalized
        }
      })
      .onConflictDoNothing({ target: outboxEvents.notificationKey });
  }
}

async function persistDuplicateAudit(
  transaction: DatabaseTransaction,
  command: PaymentCommand,
  original: CommandResult,
  currentState: LockedOrder['state']
): Promise<void> {
  await transaction.insert(domainEvents).values({
    id: randomUUID(),
    orderId: command.orderId,
    eventName: 'duplicate-ignored',
    payload: {
      eventKey: command.eventKey,
      command: command.type,
      outcome: 'duplicate-ignored',
      originalOutcome: original.outcome,
      resultingState: currentState
    }
  });
}

function terminalAllocation(order: LockedOrder): { product: bigint; refund: bigint } {
  const courierPaid = BigInt(order.courier_paid_satang);
  const allowance = BigInt(order.shipping_cap_satang);
  const overage = courierPaid > allowance ? courierPaid - allowance : 0n;
  const product = BigInt(order.product_satang) > overage ? BigInt(order.product_satang) - overage : 0n;
  const refund = allowance > courierPaid ? allowance - courierPaid : 0n;
  return { product, refund };
}

function feeOf(value: SatangInput): bigint {
  const fee = toSatang(value);
  if (fee < 0n) throw new Error('invalid charged fee');
  return fee;
}

function hasReleaseGate(order: LockedOrder): boolean {
  return order.courier_charge_finalized && order.delivered_at !== null;
}

async function assertAndLog(
  transaction: DatabaseTransaction,
  command: PaymentCommand,
  context: CommandContext,
  startedAt: number
): Promise<void> {
  try {
    await assertOrderInvariants(transaction, command.orderId);
  } catch (error) {
    logInvariantFailure(context, command, startedAt, error);
    throw error;
  }
  logCommand(context, command, 'invariant_passed', 'passed', startedAt);
}

async function save(
  transaction: DatabaseTransaction,
  order: LockedOrder,
  state: LockedOrder['state'],
  courierPaid: bigint,
  courierCharge: bigint,
  courierFinalized: boolean,
  deliveredAt: Date | null,
  buyerConfirmedAt: Date | null,
  product: bigint,
  refunded: bigint
): Promise<LockedOrder> {
  return saveOrder(
    transaction,
    order.id,
    state,
    courierPaid,
    courierCharge,
    courierFinalized,
    deliveredAt,
    buyerConfirmedAt,
    product,
    refunded
  );
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
      const lockStartedAt = Date.now();
      const order = await lockOrder(transaction, command.orderId);
      const lockWaitMs = Date.now() - lockStartedAt;
      if (lockWaitMs > 0) {
        logCommand(context, command, 'order_lock_waited', 'waited', startedAt, { wait_duration_ms: lockWaitMs });
      }
      logCommand(context, command, 'order_lock_acquired', 'acquired', startedAt);
      const existing = await transaction
        .select({ result: processedEvents.result })
        .from(processedEvents)
        .where(eq(processedEvents.eventKey, command.eventKey))
        .limit(1);
      if (existing[0]) {
        const original = existing[0].result as CommandResult;
        const duplicate = { ...original, outcome: 'duplicate-ignored' as const };
        await persistDuplicateAudit(transaction, command, original, order.state);
        const timerCompleted = await completeOwnedTimer(transaction, command);
        return timerCompleted ? { ...duplicate, timerCompleted } : duplicate;
      }

      const transactionId = randomUUID();
      let next = order;
      let postings: LedgerEntryToAppend[] = [];
      let releasedSatang = 0n;
      const courierPaid = BigInt(order.courier_paid_satang);
      const courierCharge = BigInt(order.courier_charge_satang);
      const productReleased = BigInt(order.product_released_satang);
      const refunded = BigInt(order.refunded_satang);
      const now = new Date();

      try {
        switch (command.type) {
          case 'seller_accepted_and_funded': {
            if (order.state !== 'pre_payment') throw new DomainRejection('Reserved', command.type);
            postings = entriesFor(order.id, transactionId, postHold(BigInt(order.total_satang)));
            next = await save(transaction, order, 'Reserved', 0n, 0n, false, null, null, 0n, 0n);
            await schedule(transaction, order, 'ship_by_expired', order.ship_by, command.eventKey, {});
            break;
          }
          case 'courier_pickup': {
            const fee = feeOf(command.chargedFee);
            transition(order.state as PaymentState, triggerFor(command));
            if (fee > BigInt(order.total_satang)) {
              next = await save(transaction, order, 'PendingVerification', courierPaid, fee, false, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded);
              await schedule(transaction, order, 'verification_expired', order.verification_deadline, command.eventKey, {});
              break;
            }
            postings = entriesFor(order.id, transactionId, postCourierCharge(fee));
            next = await save(transaction, order, 'Shipped', fee, fee, false, null, order.buyer_confirmed_at, productReleased, refunded);
            await schedule(transaction, order, 'auto_release_expired', order.dispute_deadline, command.eventKey, {});
            break;
          }
          case 'operations_verify_fee': {
            const fee = feeOf(command.chargedFee);
            transition(order.state as PaymentState, triggerFor(command));
            if (fee > BigInt(order.total_satang)) {
              next = await save(transaction, order, 'PendingVerification', courierPaid, fee, false, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded);
              await schedule(transaction, order, 'verification_expired', order.verification_deadline, command.eventKey, {});
              break;
            }
            postings = entriesFor(order.id, transactionId, postCourierCharge(fee));
            next = await save(transaction, order, 'Shipped', fee, fee, true, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded);
            await schedule(transaction, order, 'auto_release_expired', order.dispute_deadline, command.eventKey, {});
            break;
          }
          case 'courier_unavailable': {
            const result = transition(order.state as PaymentState, triggerFor(command));
            next = await save(transaction, order, result.to, courierPaid, courierCharge, order.courier_charge_finalized, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded);
            await schedule(transaction, order, 'verification_expired', order.verification_deadline, command.eventKey, {});
            break;
          }
          case 'courier_delivered': {
            transition(order.state as PaymentState, triggerFor(command));
            if (order.delivered_at) throw new DomainRejection(order.state as PaymentState, command.type);
            next = await save(transaction, order, 'Shipped', courierPaid, courierCharge, order.courier_charge_finalized, now, order.buyer_confirmed_at, productReleased, refunded);
            if (order.buyer_confirmed_at && order.courier_charge_finalized) {
              const allocation = terminalAllocation(next);
              postings = [
                ...entriesFor(order.id, transactionId, postProductRelease(allocation.product)),
                ...entriesFor(order.id, transactionId, postRefund(allocation.refund))
              ];
              next = await save(transaction, next, 'Released', courierPaid, courierCharge, true, now, order.buyer_confirmed_at, productReleased + allocation.product, refunded + allocation.refund);
              releasedSatang = allocation.product + allocation.refund;
            }
            break;
          }
          case 'courier_charge_updated': {
            const fee = feeOf(command.chargedFee);
            transition(order.state as PaymentState, triggerFor(command));
            if (fee > BigInt(order.total_satang)) {
              next = await save(transaction, order, 'PendingVerification', courierPaid, fee, false, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded);
              await schedule(transaction, order, 'verification_expired', order.verification_deadline, command.eventKey, {});
              break;
            }
            postings = entriesFor(order.id, transactionId, postCourierChargeAdjustment(courierPaid, fee));
            next = await save(transaction, order, 'Shipped', fee, fee, command.finalized, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded);
            if (command.finalized && order.delivered_at && order.buyer_confirmed_at) {
              const allocation = terminalAllocation(next);
              postings.push(
                ...entriesFor(order.id, transactionId, postProductRelease(allocation.product)),
                ...entriesFor(order.id, transactionId, postRefund(allocation.refund))
              );
              next = await save(transaction, next, 'Released', fee, fee, true, order.delivered_at, order.buyer_confirmed_at, productReleased + allocation.product, refunded + allocation.refund);
              releasedSatang = allocation.product + allocation.refund;
            }
            break;
          }
          case 'buyer_confirmed': {
            transition(order.state as PaymentState, triggerFor(command));
            if (!hasReleaseGate(order)) {
              next = await save(transaction, order, 'Shipped', courierPaid, courierCharge, order.courier_charge_finalized, order.delivered_at, order.buyer_confirmed_at ?? now, productReleased, refunded);
              break;
            }
            const allocation = terminalAllocation(order);
            postings = [
              ...entriesFor(order.id, transactionId, postProductRelease(allocation.product)),
              ...entriesFor(order.id, transactionId, postRefund(allocation.refund))
            ];
            next = await save(transaction, order, 'Released', courierPaid, courierCharge, order.courier_charge_finalized, order.delivered_at, order.buyer_confirmed_at ?? now, productReleased + allocation.product, refunded + allocation.refund);
            releasedSatang = allocation.product + allocation.refund;
            break;
          }
          case 'auto_release_expired': {
            transition(order.state as PaymentState, triggerFor(command));
            if (!hasReleaseGate(order)) throw new DomainRejection(order.state as PaymentState, command.type);
            const allocation = terminalAllocation(order);
            postings = [
              ...entriesFor(order.id, transactionId, postProductRelease(allocation.product)),
              ...entriesFor(order.id, transactionId, postRefund(allocation.refund))
            ];
            next = await save(transaction, order, 'Released', courierPaid, courierCharge, order.courier_charge_finalized, order.delivered_at, order.buyer_confirmed_at, productReleased + allocation.product, refunded + allocation.refund);
            releasedSatang = allocation.product + allocation.refund;
            break;
          }
          case 'buyer_disputed': {
            const result = transition(order.state as PaymentState, triggerFor(command));
            next = await save(transaction, order, result.to, courierPaid, courierCharge, order.courier_charge_finalized, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded);
            break;
          }
          case 'operations_resolve_refund': {
            const result = transition(order.state as PaymentState, triggerFor(command));
            const remaining = remainingSatang(order);
            postings = entriesFor(order.id, transactionId, postRefund(remaining));
            next = await save(transaction, order, result.to, courierPaid, courierCharge, order.courier_charge_finalized, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded + remaining);
            releasedSatang = remaining;
            break;
          }
          case 'operations_resolve_release': {
            transition(order.state as PaymentState, triggerFor(command));
            if (!order.courier_charge_finalized) throw new DomainRejection(order.state as PaymentState, command.type);
            const allocation = terminalAllocation(order);
            postings = [
              ...entriesFor(order.id, transactionId, postProductRelease(allocation.product)),
              ...entriesFor(order.id, transactionId, postRefund(allocation.refund))
            ];
            next = await save(transaction, order, 'Released', courierPaid, courierCharge, order.courier_charge_finalized, order.delivered_at, order.buyer_confirmed_at, productReleased + allocation.product, refunded + allocation.refund);
            releasedSatang = allocation.product + allocation.refund;
            break;
          }
          case 'ship_by_expired':
          case 'verification_expired': {
            const result = transition(order.state as PaymentState, triggerFor(command));
            const remaining = remainingSatang(order);
            postings = entriesFor(order.id, transactionId, postRefund(remaining));
            next = await save(transaction, order, result.to, courierPaid, courierCharge, order.courier_charge_finalized, order.delivered_at, order.buyer_confirmed_at, productReleased, refunded + remaining);
            releasedSatang = remaining;
            break;
          }
        }

        if (postings.length) logCommand(context, command, 'ledger_posted', 'posted', startedAt, { posting_count: postings.length });
        if (postings.length) await appendLedgerEntries(transaction, postings);
        const processed: CommandResult = {
          outcome: 'processed',
          order: publicOrder(next),
          event: { name: command.type, eventKey: command.eventKey },
          ...(releasedSatang ? { releasedSatang: releasedSatang.toString() } : {})
        };
        await assertAndLog(transaction, command, context, startedAt);
        const timerCompleted = await completeOwnedTimer(transaction, command);
        const completedResult = timerCompleted ? { ...processed, timerCompleted } : processed;
        await persistOutcome(transaction, command, completedResult);
        return completedResult;
      } catch (error) {
        if (!(error instanceof DomainRejection)) throw error;
        const rejected: CommandResult = {
          outcome: 'rejected-invalid-transition',
          order: publicOrder(order),
          event: { name: command.type, eventKey: command.eventKey }
        };
        await assertAndLog(transaction, command, context, startedAt);
        const timerCompleted = await completeOwnedTimer(transaction, command);
        const completedResult = timerCompleted ? { ...rejected, timerCompleted } : rejected;
        await persistOutcome(transaction, command, completedResult);
        return completedResult;
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
