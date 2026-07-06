// ---------------------------------------------------------------------------
// drainPages — exhaustively page a cursor-paginated Vectros auth list endpoint.
//
// The auth/access list endpoints (listRoles, listAccessProfiles,
// listAppContexts) return the `{ data, nextCursor }` envelope: at most
// `limit` items (default 20) plus an opaque `nextCursor` that is null on the
// final page. Anything that must be complete — the context list and its
// per-context role/profile *counts*, the role/profile editor pickers — would
// silently truncate past the first page without draining.
//
// This differs from app-vectros's drainPages on purpose: that one unwraps each
// page's `.data` at the call site and derives the next cursor from the last
// item's id. Here we follow `nextCursor` from the page envelope directly — the
// authoritative envelope cursor, null-terminated. (listScopedKeys is the one auth
// list that takes no pagination params, so it can't be drained.)
// ---------------------------------------------------------------------------

/** Maximum results to request per page (the SDK ceiling is 100; default is 20). */
export const AUTH_PAGE_SIZE = 100;

/** Default safety ceiling on pages drained (guards a non-advancing cursor). */
const DEFAULT_MAX_PAGES = 50;

/** A single page: the items plus the opaque next-page cursor (null when exhausted). */
export interface CursorPage<T> {
  readonly data?: readonly T[] | undefined;
  readonly nextCursor?: (string | null) | undefined;
}

/**
 * Drain every page of a cursor-paginated auth list endpoint into one array.
 *
 * `fetchPage(startFrom)` returns one `{ data, nextCursor }` page (omit
 * `startFrom` on the first call). We follow `nextCursor` until it is
 * null/absent (exhaustion) or stops advancing (defensive against a
 * server bug that would otherwise loop). Bounded by `maxPages`.
 *
 * @param fetchPage fetch a single page given the previous page's cursor (undefined on the first page)
 * @param maxPages  hard ceiling on pages (default 50)
 */
export async function drainPages<T>(
  fetchPage: (startFrom: string | undefined) => Promise<CursorPage<T>>,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  let startFrom: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { data, nextCursor } = await fetchPage(startFrom);
    if (data) all.push(...data);
    // A null/absent cursor means no more pages. The self-equality check
    // defends against a non-advancing cursor (which would otherwise loop).
    if (nextCursor === undefined || nextCursor === null || nextCursor === startFrom) {
      break;
    }
    startFrom = nextCursor;
  }
  return all;
}
