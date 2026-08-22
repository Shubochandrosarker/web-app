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

  static conflict(message: string): ApiError {
    return new ApiError(409, 'conflict', message);
  }

  static tooManyRequests(message = 'Too many requests. Please try again later.'): ApiError {
    return new ApiError(429, 'too_many_requests', message);
  }

  /**
   * One message for every credential failure.
   *
   * "No such account", "wrong password" and "account suspended" are three
   * facts an attacker would like and a legitimate user does not need. The
   * distinction is recorded in the audit log, where it is useful and not
   * reachable from outside.
   */
  static invalidCredentials(): ApiError {
    return new ApiError(401, 'invalid_credentials', 'Those sign-in details are not correct');
  }

  /**
   * A resource in another tenant.
   *
   * Deliberately a 404 and not a 403: answering "you may not see this" tells
   * the caller the id exists, which is enough to enumerate another workspace's
   * records one guess at a time. To a caller outside the tenant, the row does
   * not exist — and that is also the honest answer, because row-level security
   * means the query genuinely returned nothing.
   */
  static hidden(what: string): ApiError {
    return new ApiError(404, 'not_found', `${what} not found`);
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
        requestId: request.id,
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
        requestId: request.id,
      });
    }

    /*
     * Fastify's own errors already carry a safe status and code (body too
     * large, unsupported media type, rate limited). Passing them through keeps
     * a 413 from being reported to the client as an unexplained 500, while
     * anything 5xx still falls through to the opaque handler below.
     */
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    const status = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;

    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        error: {
          code: fastifyError.code ?? 'bad_request',
          message: fastifyError.message ?? 'The request could not be processed',
        },
        requestId: request.id,
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Something went wrong' },
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: 'No such route' }, requestId: request.id }),
  );
}
