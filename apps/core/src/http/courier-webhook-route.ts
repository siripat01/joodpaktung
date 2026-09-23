import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { handleCommand, type PaymentCommand } from '../application/command-handler.js';
import { getDatabase } from '../db/pool.js';
import { orders } from '../db/schema.js';
import { CourierWebhookError, type CourierProviderPort, type NormalizedCourierEvent } from '../ports/courier-provider.js';

function commandFor(event: NormalizedCourierEvent, orderId: string): PaymentCommand {
  switch (event.kind) {
    case 'picked_up':
      return { type: 'courier_pickup', orderId, eventKey: event.eventKey, chargedFee: event.chargedFee };
    case 'delivered':
      return { type: 'courier_delivered', orderId, eventKey: event.eventKey };
    case 'courier_charge_updated':
      return { type: 'courier_charge_updated', orderId, eventKey: event.eventKey, chargedFee: event.chargedFee, finalized: event.finalized };
  }
}

export function registerCourierWebhookRoute(app: FastifyInstance, courierProvider: CourierProviderPort): void {
  app.post('/webhooks/courier', async (request, reply) => {
    const traceId = randomUUID();
    const signature = request.headers['x-courier-signature'];
    if (!Buffer.isBuffer(request.body)) {
      request.log.info({ event: 'courier_webhook_rejected', trace_id: traceId, request_id: request.id, provider: 'courier', outcome: 'invalid_request' });
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (typeof signature !== 'string') {
      request.log.info({ event: 'courier_webhook_rejected', trace_id: traceId, request_id: request.id, provider: 'courier', outcome: 'invalid_signature' });
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    let event: NormalizedCourierEvent;
    try {
      event = await courierProvider.verifyAndNormalize({ rawBody: request.body, signature });
    } catch (error) {
      const invalidSignature = error instanceof CourierWebhookError && error.code === 'invalid_signature';
      const invalidPayload = error instanceof CourierWebhookError && error.code === 'invalid_payload';
      request.log.info({
        event: 'courier_webhook_rejected', trace_id: traceId, request_id: request.id, provider: 'courier',
        outcome: invalidSignature ? 'invalid_signature' : invalidPayload ? 'invalid_payload' : 'verification_failure',
        error_type: error instanceof Error ? error.name : 'unknown'
      });
      if (invalidSignature) return reply.code(401).send({ error: 'invalid_signature' });
      if (invalidPayload) return reply.code(400).send({ error: 'invalid_payload' });
      return reply.code(503).send({ error: 'verification_unavailable' });
    }

    const matchingOrder = await getDatabase()
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.shipmentToken, event.shipmentToken))
      .limit(1);
    const order = matchingOrder[0];
    if (!order) {
      request.log.info({ event: 'courier_webhook_rejected', trace_id: traceId, request_id: request.id,
        event_key: event.eventKey, provider: 'courier', outcome: 'unknown_shipment' });
      return reply.code(404).send({ error: 'unknown_shipment' });
    }

    request.log.info({ event: 'courier_webhook_verified', trace_id: traceId, request_id: request.id,
      order_id: order.id, event_key: event.eventKey, provider: 'courier', outcome: 'verified' });
    const result = await handleCommand(commandFor(event, order.id), {
      traceId, requestId: request.id, logger: request.log
    });
    return reply.code(202).send(result);
  });
}
