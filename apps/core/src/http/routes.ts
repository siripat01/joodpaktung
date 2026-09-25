import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { handleCommand } from '../application/command-handler.js';
import type { CommandContext, PaymentCommand } from '../application/commands.js';
import { getConsoleProjection, getOrderProjection } from './projections.js';

const base = { orderId: z.uuid(), eventKey: z.string().min(1).max(200) };
const fee = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);
const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('seller_accepted_and_funded'), pin: z.string().regex(/^\d{4,6}$/).optional() }),
  z.strictObject({ ...base, type: z.literal('courier_pickup'), chargedFee: fee }),
  z.strictObject({ ...base, type: z.literal('courier_charge_updated'), chargedFee: fee, finalized: z.boolean() }),
  z.strictObject({ ...base, type: z.literal('operations_verify_fee'), chargedFee: fee, evidenceRef: z.string().trim().min(1) }),
  ...(['courier_delivered', 'courier_unavailable', 'buyer_confirmed', 'buyer_disputed', 'ship_by_expired', 'verification_expired', 'auto_release_expired'] as const)
    .map((type) => z.strictObject({ ...base, type: z.literal(type) })),
  ...(['operations_resolve_refund', 'operations_resolve_release'] as const)
    .map((type) => z.strictObject({ ...base, type: z.literal(type), evidenceRef: z.string().trim().min(1) }))
]);

type ExecuteCommand = (command: PaymentCommand, context: CommandContext) => Promise<Awaited<ReturnType<typeof handleCommand>>>;

export function registerRoutes(app: FastifyInstance, execute: ExecuteCommand = handleCommand): void {
  app.post('/commands', async (request, reply) => {
    // Raw JSON buffers are required by the signed webhook, so parse ordinary
    // commands explicitly and never log the raw body or mock PIN.
    let body: unknown;
    try {
      body = JSON.parse((request.body as Buffer).toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid_json' });
    }
    const parsed = commandSchema.safeParse(body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_command' });
    const { pin: _pin, ...rest } = 'pin' in parsed.data ? parsed.data : { ...parsed.data, pin: undefined };
    const command = rest as PaymentCommand;
    try {
      const result = await execute(command, { traceId: randomUUID(), requestId: request.id, logger: request.log });
      return reply.code(result.outcome === 'rejected-invalid-transition' ? 202 : 200).send(result);
    } catch (error) {
      request.log.error({ event: 'command_http_failed', request_id: request.id, order_id: command.orderId,
        event_key: command.eventKey, error_type: error instanceof Error ? error.name : 'unknown' });
      return reply.code(500).send({ error: 'command_failed' });
    }
  });

  app.get<{ Params: { orderId: string } }>('/orders/:orderId', async (request, reply) => {
    if (!z.uuid().safeParse(request.params.orderId).success) return reply.code(400).send({ error: 'invalid_order_id' });
    const order = await getOrderProjection(request.params.orderId);
    return order ?? reply.code(404).send({ error: 'order_not_found' });
  });

  app.get<{ Querystring: { orderId: string } }>('/console', async (request, reply) => {
    if (!z.uuid().safeParse(request.query.orderId).success) return reply.code(400).send({ error: 'invalid_order_id' });
    const consoleProjection = await getConsoleProjection(request.query.orderId);
    return consoleProjection ?? reply.code(404).send({ error: 'order_not_found' });
  });
}
