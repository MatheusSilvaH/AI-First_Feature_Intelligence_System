/** Errors we deliberately surface to the client, with a stable machine code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, details);

export const notFound = (resource: string, id?: string) =>
  new AppError(404, "not_found", id ? `${resource} '${id}' not found` : `${resource} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, "conflict", message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, "unprocessable_entity", message, details);

/** The AI layer could not produce a usable result after its retries. */
export class AiPipelineError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`[${stage}] ${message}`);
    this.name = "AiPipelineError";
  }
}
