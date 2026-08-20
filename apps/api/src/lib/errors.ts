import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/**
 * One error shape for the whole API.
 *
 * Clients get a stable `{ error: { code, message, details? } }`, and internal
 * detail never crosses the boundary: a database error becomes
 * `internal_error`, logged in full server-side. Leaking a constraint name
 * tells an attacker the schema.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static notFound(what: string): ApiError {
    return new ApiError(404, 'not_found', `${what} not found`);
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  static unauthorized(): ApiError {
    return new ApiError(401, 'unauthorized', 'Authentication is required');
  }

  static forbidden(): ApiError {
    return new ApiError(403, 'forbidden', 'You do not have access to this resource');
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: 'The request did not match the expected shape',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong' },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'No such route' } }),
  );
}
