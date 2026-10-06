import { z } from 'zod';

/**
 * Single error type used by services. Controllers (REST) and gateways (Socket.IO ACK)
 * translate it into the same `{ code, message }` shape. Stack traces never leave the server.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Overrides the default (5xx = retryable) for ACKs, e.g. "send session:start first, then retry". */
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new AppError(400, code, message, details);
  }
  static unauthorized(code: string, message: string) {
    return new AppError(401, code, message);
  }
  static forbidden(code: string, message: string) {
    return new AppError(403, code, message);
  }
  static notFound(code: string, message: string) {
    return new AppError(404, code, message);
  }
  static conflict(code: string, message: string, details?: unknown) {
    return new AppError(409, code, message, details);
  }
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

/** Normalizes any thrown value into { status, body }. Unknown errors become a generic 500. */
export function toErrorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return { status: err.status, body: { code: err.code, message: err.message, details: err.details, retryable: err.retryable } };
  }
  if (err instanceof z.ZodError) {
    return {
      status: 400,
      body: { code: 'VALIDATION_ERROR', message: 'Invalid request payload', details: z.flattenError(err) },
    };
  }
  return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
}
