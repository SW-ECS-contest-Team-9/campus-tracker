import type { CollectorIdentity } from '../common/auth/jwt.js';
import { toErrorBody, type ErrorBody } from '../common/errors/app-error.js';
import { logger } from '../common/logger.js';
import { collectorController } from '../modules/collectors/collector.controller.js';
import { sessionController } from '../modules/sessions/session.controller.js';
import { telemetryController } from '../modules/telemetry/telemetry.controller.js';
import { markerController } from '../modules/markers/marker.controller.js';

// Collector events shared by both transports (Socket.IO /collector and raw WebSocket /ws/collector).
// Each handler validates its DTO, runs the service (DB COMMIT included) and returns the ACK body.

type Handler = (identity: CollectorIdentity, payload: unknown) => unknown | Promise<unknown>;

export const COLLECTOR_EVENTS = [
  'session:start',
  'session:finish',
  'session:syncComplete',
  'session:diagnostics',
  'telemetry:batch',
  'marker:create',
  'collector:status',
  'diagnostic:event',
] as const;

/** Accepts both naming styles: "session:start" (contract) and "session.start". */
export function normalizeEventName(name: string): string {
  return name.includes(':') ? name : name.replace('.', ':');
}

// Resolved at call time (not module load): the controllers sit in an import cycle with the gateways.
function handlerFor(event: string): Handler | undefined {
  switch (event) {
    case 'session:start': return sessionController.start;
    case 'session:finish': return sessionController.finish;
    case 'telemetry:batch': return telemetryController.batch;
    case 'marker:create': return markerController.create;
    case 'collector:status': return collectorController.status;
    case 'session:syncComplete': return sessionController.syncComplete;
    case 'session:diagnostics': return sessionController.diagnostics;
    case 'diagnostic:event': return sessionController.diagnosticEvents;
    default: return undefined;
  }
}

export interface AckError extends ErrorBody {
  status: number;
  /** false (4xx): the same payload will fail again. true (5xx): transient, keep it queued and retry. */
  retryable: boolean;
}

export type EventResult = { ok: true; result: unknown } | { ok: false; error: AckError };

/** Internal error description for the server log only (pg connection errors often have an empty message). */
function describe(err: unknown): string {
  if (err instanceof AggregateError) return err.errors.map(describe).join('; ');
  if (err instanceof Error) return err.message || (err as NodeJS.ErrnoException).code || err.name;
  return String(err);
}

/** Runs one collector event and normalizes errors. Never throws; stack traces/DB details stay in the server log. */
export async function runCollectorEvent(
  transport: 'socket.io' | 'raw_ws',
  identity: CollectorIdentity,
  event: string,
  payload: unknown,
): Promise<EventResult> {
  const handler = handlerFor(normalizeEventName(event));
  if (!handler) {
    return { ok: false, error: { code: 'UNKNOWN_TYPE', message: `Unknown message type: ${event}`, status: 400, retryable: false } };
  }
  try {
    return { ok: true, result: await handler(identity, payload) };
  } catch (err) {
    const { status, body } = toErrorBody(err);
    const log = status >= 500 ? logger.error : logger.warn;
    log(`${transport}.${event}.failed`, {
      collectorId: identity.collectorId,
      status,
      code: body.code,
      message: status >= 500 ? describe(err) : body.message,
    });
    return { ok: false, error: { ...body, status, retryable: body.retryable ?? status >= 500 } };
  }
}
