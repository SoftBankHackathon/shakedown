/** An engine error with its HTTP status, so callers can react to e.g. 409 (already running). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
