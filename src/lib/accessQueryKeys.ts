// ---------------------------------------------------------------------------
// TanStack Query keys for the Access surface.
//
// Why centralized constants: the three Access entities (AppContext, Role,
// AccessProfile) get queried + invalidated from multiple files (list pages,
// detail pages, editors, clone dialogs, delete confirmations). String-literal
// keys at each site invite drift — KeysPage shipped with
// `['scopedKeys', tenant]` at the query site and just `['scopedKeys']` at
// one invalidation site, and the cache silently fragmented. Centralizing
// here makes drift a typecheck error.
//
// Convention (matches `KeysPage`'s `['scopedKeys']` flat-array shape):
//   - Top-level entity name first, then path discriminators.
//   - Specific keys narrow the broader ones — invalidating `appContexts()`
//     also invalidates the per-id detail.
//
// References:
//   - ui/admin-app/src/lib/queryClient.ts (the shared client config)
// ---------------------------------------------------------------------------

/**
 * Query keys for the Access surface. Use as the `queryKey` and the
 * `invalidateQueries({ queryKey })` argument.
 *
 * Example:
 *
 *     useQuery({
 *       queryKey: accessQueryKeys.profiles(ctxId),
 *       // Auth lists are cursor-paginated — drain to completeness (see drainPages).
 *       queryFn: () =>
 *         drainPages<AccessProfileResponse>((startFrom) =>
 *           client.auth.listAccessProfiles(
 *             startFrom === undefined
 *               ? { contextId: ctxId, limit: AUTH_PAGE_SIZE }
 *               : { contextId: ctxId, startFrom, limit: AUTH_PAGE_SIZE },
 *           ),
 *         ),
 *     });
 *
 *     queryClient.invalidateQueries({ queryKey: accessQueryKeys.profiles(ctxId) });
 */
export const accessQueryKeys = {
  /** All app contexts for the active tenant. */
  appContexts: (): readonly ['appContexts'] => ['appContexts'] as const,

  /** One specific app context (read endpoint). Narrows `appContexts()`. */
  appContext: (contextId: string): readonly ['appContexts', string] =>
    ['appContexts', contextId] as const,

  /** All roles in a context. */
  roles: (
    contextId: string,
  ): readonly ['roles', string] =>
    ['roles', contextId] as const,

  /** One specific role. Narrows `roles(ctxId)`. */
  role: (
    contextId: string,
    roleId: string,
  ): readonly ['roles', string, string] =>
    ['roles', contextId, roleId] as const,

  /** All access profiles in a context. */
  profiles: (contextId: string): readonly ['accessProfiles', string] =>
    ['accessProfiles', contextId] as const,

  /** One specific access profile. Narrows `profiles(ctxId)`. */
  profile: (
    contextId: string,
    principalId: string,
  ): readonly ['accessProfiles', string, string] =>
    ['accessProfiles', contextId, principalId] as const,

  /** All registered trusted issuers for the active tenant (0.42.0). */
  issuers: (): readonly ['issuers'] => ['issuers'] as const,
} as const;
