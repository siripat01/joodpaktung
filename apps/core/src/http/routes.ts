import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { handleCommand } from '../application/command-handler.js';
import { getConsoleProjection, getOrderProjection } from './projections.js';
import { startSse } from './sse.js';

const base = { orderId: z.string().uuid(), eventKey: z.string().min(1).max(200) };
const satang = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d{1,18}$/).refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)
]);
const PaymentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('seller_accepted_and_funded'), ...base }).strict(),
  z.object({ type: z.literal('courier_delivered'), ...base }).strict(),
  z.object({ type: z.literal('courier_unavailable'), ...base }).strict(),
  z.object({ type: z.literal('buyer_confirmed'), ...base }).strict(),
  z.object({ type: z.literal('buyer_disputed'), ...base }).strict(),
  z.object({ type: z.literal('ship_by_expired'), ...base, leaseToken: z.string().min(16).max(300) }).strict(),
  z.object({ type: z.literal('verification_expired'), ...base, leaseToken: z.string().min(16).max(300) }).strict(),
  z.object({ type: z.literal('auto_release_expired'), ...base, leaseToken: z.string().min(16).max(300) }).strict(),
  z.object({ type: z.literal('courier_pickup'), ...base, chargedFee: satang }).strict(),
  z.object({ type: z.literal('courier_charge_updated'), ...base, chargedFee: satang, finalized: z.boolean() }).strict(),
  z.object({ type: z.literal('operations_verify_fee'), ...base, chargedFee: satang, evidenceRef: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal('operations_resolve_refund'), ...base, evidenceRef: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal('operations_resolve_release'), ...base, evidenceRef: z.string().trim().min(1).max(200) }).strict()
]);

function parseBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  return JSON.parse(body.toString('utf8')) as unknown;
}

export function registerCoreRoutes(app: FastifyInstance): void {
  app.post('/commands', async (request, reply) => {
    const suppliedTraceId = request.headers['x-trace-id'];
    const traceId = typeof suppliedTraceId === 'string' && suppliedTraceId.trim() ? suppliedTraceId.slice(0, 200) : randomUUID();
    let body: unknown;
    try {
      body = parseBody(request.body);
    } catch {
      request.log.info({ event: 'command_rejected', trace_id: traceId, request_id: request.id,
        outcome: 'rejected-invalid-input', validation_issues: ['invalid_json'] });
      return reply.code(400).send({ error: 'invalid_command' });
    }
    const parsed = PaymentCommandSchema.safeParse(body);
    if (!parsed.success) {
      request.log.info({ event: 'command_rejected', trace_id: traceId, request_id: request.id,
        outcome: 'rejected-invalid-input', validation_issues: parsed.error.issues.map((issue) => issue.code) });
      return reply.code(400).send({ error: 'invalid_command' });
    }
    const result = await handleCommand(parsed.data, { traceId, requestId: request.id, logger: request.log });
    return reply.code(result.outcome === 'rejected-invalid-transition' ? 202 : 200).send(result);
  });

  app.get<{ Params: { orderId: string } }>('/orders/:orderId', async (request, reply) => {
    if (!z.string().uuid().safeParse(request.params.orderId).success) return reply.code(400).send({ error: 'invalid_order_id' });
    const projection = await getOrderProjection(request.params.orderId);
    return projection ? reply.send(projection) : reply.code(404).send({ error: 'order_not_found' });
  });
  app.get('/console', async () => getConsoleProjection());
  app.get('/events', async (request, reply) => startSse(request, reply));
}
