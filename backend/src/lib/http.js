import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, code = undefined, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, 'BAD_REQUEST', details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'You do not have access to this resource') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg) => new HttpError(409, msg, 'CONFLICT');

/** Wrap an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validate req[part] with a zod schema and return the parsed value. */
export function parse(schema, value) {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw badRequest(
      'Invalid request',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function errorHandler(isProd) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof ZodError) err = badRequest('Invalid request');
    if (err?.type === 'entity.parse.failed') err = badRequest('Malformed JSON body');

    // PostgreSQL constraint violations → client errors, not 500s.
    if (err?.code === '23505') err = conflict('That record conflicts with an existing one');
    if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22007') err = badRequest('Invalid data');

    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);

    res.status(status).json({
      success: false,
      error: {
        code: err.code && typeof err.code === 'string' && !/^\d/.test(err.code) ? err.code : status >= 500 ? 'INTERNAL' : 'ERROR',
        message: status >= 500 && isProd ? 'Something went wrong. Please try again.' : err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  };
}
