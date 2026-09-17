import type { RequestHandler } from "express";
import type { z } from "zod";
import { badRequest } from "../../lib/errors.js";

/**
 * Validation happens at the HTTP boundary and nowhere else. Past this point,
 * services receive typed, known-good input and do not re-check it.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      valid?: { body?: unknown; query?: unknown };
    }
  }
}

const issues = (error: z.ZodError) =>
  error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

export const validateBody =
  <S extends z.ZodType>(schema: S): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(badRequest("Request body failed validation", issues(result.error)));
    }
    req.valid = { ...req.valid, body: result.data };
    next();
  };

export const validateQuery =
  <S extends z.ZodType>(schema: S): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(badRequest("Query parameters failed validation", issues(result.error)));
    }
    req.valid = { ...req.valid, query: result.data };
    next();
  };

export const body = <T>(req: Express.Request): T => req.valid?.body as T;
export const query = <T>(req: Express.Request): T => req.valid?.query as T;

/**
 * Express 5 types a path param as `string | string[]`, because a repeated
 * `:id` in a pattern yields an array. None of our routes do that, so collapse
 * it here rather than asserting at a dozen call sites.
 */
export function pathParam(
  params: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = params[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
