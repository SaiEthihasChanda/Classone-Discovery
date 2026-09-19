import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';

/** An error carrying an intended HTTP status — thrown by controllers for expected failures. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static notFound(what: string) {
    return new ApiError(404, `${what} not found`);
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, message, details);
  }
}

/**
 * Wraps an async route handler so a rejected promise reaches the error handler.
 * Express 4 does not catch async rejections on its own; without this, a failed
 * await hangs the request instead of returning a 500.
 */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `No route matches ${req.method} ${req.path}` });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error handlers by arity; `next` must stay.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[error]', err);

  res.status(500).json({
    error: 'Internal server error',
    // The real message helps while developing but must not leak in production.
    ...(env.isProduction ? {} : { details: message }),
  });
}
