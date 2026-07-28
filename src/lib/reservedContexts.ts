// ---------------------------------------------------------------------------
// The reserved AppContext ids every tenant carries. One shared home for both
// literals so call sites that need to special-case one of them import a
// constant instead of re-declaring the string — independent copies of the
// same literal are how a call site gets missed when the backend's rules
// around a reserved context change (as happened with `vectros-admin`).
// ---------------------------------------------------------------------------

/**
 * The reserved, auto-seeded control-plane context. Non-data-bearing; the
 * partner API rejects an explicit token mint pinned to it (both as a bearer's
 * own context and as a request-body `contextId` the bearer's context must
 * match), so nothing in this app mints against it, offers it as a pickable
 * target context, or fetches per-context data for it.
 */
export const RESERVED_VECTROS_ADMIN_CONTEXT_ID = 'vectros-admin';

/** The reserved base context every tenant keeps — the server refuses to delete it. */
export const RESERVED_DEFAULT_CONTEXT_ID = 'default';
