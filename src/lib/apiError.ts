// ---------------------------------------------------------------------------
// API error helpers — pull the support-correlation id out of a failed SDK call.
//
// Every partner-API error body is always-valid JSON of the shape
// `{ "message": string, "requestId": string, ...}`. The SDK surfaces it as
// `VectrosError.body` (typed `unknown`). These helpers duck-type that body so
// the UI can show the `requestId` for support WITHOUT importing the SDK's error
// classes (keeping them trivially unit-testable and resilient to SDK refactors).
//
// Kept framework-free (no React, no SDK class import) and pure.
// ---------------------------------------------------------------------------

/** The HTTP status code of a failed SDK call, if the error carries one. */
export function statusCodeOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

/**
 * True when an error from an `update*` call is an optimistic-concurrency
 * conflict (HTTP 409 `VERSION_CONFLICT`) — the entity was modified
 * since the `expectedVersion` we sent. On the update path a 409 is unambiguously
 * a version conflict (immutable identifiers are ignored on update, so no other
 * 409 arises there). Duck-typed via {@link statusCodeOf} so it doesn't depend on
 * importing the SDK's `ConflictError` class.
 */
export function isVersionConflict(err: unknown): boolean {
  return statusCodeOf(err) === 409;
}

/**
 * Extract the `requestId` correlation id from a failed SDK call, if
 * present. Reads `err.body.requestId` (the always-valid JSON error envelope);
 * returns undefined for non-API errors (network, abort) or a malformed body so
 * callers can simply omit the reference line when there's nothing to show.
 */
export function extractRequestId(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('body' in err)) return undefined;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null || !('requestId' in body)) return undefined;
  const requestId = (body as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' && requestId !== '' ? requestId : undefined;
}
