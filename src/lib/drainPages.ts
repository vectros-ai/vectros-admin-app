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
// We follow `nextCursor` from the page envelope directly — the authoritative
// envelope cursor, null-terminated. (listScopedKeys is the one auth list that
// takes no pagination params, so it can't be drained.)
//
// **The bound counts PAGES, and it FAILS CLOSED.** Two things this file used to
// get wrong, both of which read as defensive while defending nothing:
//
//  1. Comparing the new cursor against the previous one is NOT a no-progress
//     guard. The cursor is opaque and sealed with a random nonce per seal, so
//     two cursors for the same position never compare equal and that test is
//     permanently false. It has been removed rather than left in place looking
//     like a defense this file does not have.
//  2. Hitting the ceiling used to RETURN what had been read so far. That is the
//     silent truncation the drain exists to prevent, handed back under a
//     different name — and every caller here needs completeness (a role picker
//     missing its tail offers a choice that isn't there; a members table missing
//     its tail looks like the member was removed). Now it throws. Every caller
//     is a react-query `queryFn`, so the throw surfaces as that surface's error
//     state rather than as a quietly short list.
//
//     ⚠️ But a fail-closed ceiling must allow ONE MORE REQUEST than it allows
//     pages of data, or it converts a COMPLETE read into a failure. A listing of
//     exactly `maxPages × AUTH_PAGE_SIZE` rows fills every page, and a FULL page
//     still carries a live cursor — the server sets one whenever it stops on
//     `limit`, because it cannot know the next read is empty. The extra request
//     is the probe that distinguishes "exhausted" from "more to come"; without
//     it, exactly 5000 roles would be fetched and then thrown away. Note that a
//     SHORT final page is a different (and already-safe) case: the server keeps
//     reading until it can null the cursor, so it terminates within the bound.
// ---------------------------------------------------------------------------

/** Maximum results to request per page (the SDK ceiling is 100; default is 20). */
export const AUTH_PAGE_SIZE = 100;

/** Default safety ceiling on pages drained (guards a cursor that never goes null). */
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
 * `startFrom` on the first call). A null/absent cursor is the ONLY terminal
 * condition — a short or even empty page with a live cursor is normal
 * (server-side scope filtering is applied per page after its cursor is
 * captured) and the drain continues through it.
 *
 * @param fetchPage fetch a single page given the previous page's cursor (undefined on the first page)
 * @param maxPages  how many pages are chased before the drain refuses (default
 *                  50). NOT a bound on rows accumulated: the final iteration is
 *                  usually the terminal probe, but a listing that ends exactly
 *                  there returns its data too, so a successful drain can hold up
 *                  to `(maxPages + 1) × AUTH_PAGE_SIZE` rows
 * @throws if the cursor is still live once that allowance is spent — the result
 *         would be partial, and returning a partial enumeration silently is the
 *         failure this drain exists to prevent
 */
export async function drainPages<T>(
  fetchPage: (startFrom: string | undefined) => Promise<CursorPage<T>>,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  let startFrom: string | undefined;
  // `<=`, not `<`: the final iteration is the terminal probe (see rule 2).
  for (let page = 0; page <= maxPages; page++) {
    const { data, nextCursor } = await fetchPage(startFrom);
    if (data) all.push(...data);
    // Null or absent means exhausted.
    //
    // A blank cursor is folded in here, and that IS an asymmetry in an
    // otherwise fail-closed function — it returns rather than throws. Echoing
    // `''` back is the worst option: the server reads a blank `startFrom` as
    // "no resume position" and restarts the listing at page one, so the drain
    // would never end. And no server path emits it — an empty key encodes as a
    // null cursor — so this branch is defensive only, and throwing on it would
    // turn an impossible response into a user-visible failure for nothing.
    if (!nextCursor) return all;
    startFrom = nextCursor;
  }
  // BOTH numbers, because they describe different incidents and you want to
  // know which one you are holding: "5000 rows over 51 requests" is a listing
  // genuinely larger than the ceiling, "0 rows over 51 requests" is a cursor
  // that never resolves. Requests, not pages, because that is the count
  // actually made — the terminal probe is one of them.
  throw new Error(
    `drainPages: listing still not exhausted after ${maxPages + 1} requests ` +
      `(${all.length} rows read). Refusing to return a partial result.`,
  );
}
