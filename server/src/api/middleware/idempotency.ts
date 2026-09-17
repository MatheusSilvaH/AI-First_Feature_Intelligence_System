import type { RequestHandler } from "express";
import { getDb, row } from "../../db/index.js";
import { sha256, stableStringify } from "../../lib/ids.js";
import { conflict } from "../../lib/errors.js";

/**
 * Idempotent POSTs via an `Idempotency-Key` header.
 *
 * Submission is the endpoint that matters here: a double-tapped button or a
 * client retry after a timeout would otherwise create a second request, which
 * then has to be detected as a duplicate by the AI pipeline - paying for a
 * model call to clean up a problem the transport layer caused.
 *
 * Replaying a key with a *different* body is a client bug, so it is a 409
 * rather than a silent replay of the original response.
 */
export const idempotency: RequestHandler = (req, res, next) => {
  const key = req.header("Idempotency-Key");
  if (!key) return next();

  const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
  const requestHash = sha256(stableStringify({ endpoint, body: req.body }));

  const existing = row<{
    request_hash: string;
    response_status: number;
    response_body: string;
  }>(
    getDb()
      .prepare(
        "SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = ?",
      )
      .get(key),
  );

  if (existing) {
    if (existing.request_hash !== requestHash) {
      return next(
        conflict("This Idempotency-Key was already used with a different request body."),
      );
    }
    res
      .status(existing.response_status)
      .set("Idempotent-Replay", "true")
      .type("application/json")
      .send(existing.response_body);
    return;
  }

  // Capture the response so a later retry can replay it verbatim.
  const originalJson = res.json.bind(res);
  res.json = (payload: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        getDb()
          .prepare(
            `INSERT INTO idempotency_keys (key, endpoint, request_hash, response_status, response_body)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(key) DO NOTHING`,
          )
          .run(key, endpoint, requestHash, res.statusCode, JSON.stringify(payload));
      } catch {
        // Persisting the replay record must never fail the actual response.
      }
    }
    return originalJson(payload);
  };

  next();
};
