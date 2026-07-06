// ---------------------------------------------------------------------------
// pageOf — test helper that wraps a fixture array in the `{ data,
// nextCursor }` page envelope returned by the cursor-paginated auth list
// endpoints (listRoles, listAccessProfiles, listAppContexts, listScopedKeys).
// `nextCursor: null` marks a single, final page —
// what every fixture wants. Keeps the test mocks faithful to the real SDK shape
// so the drain/unwrap paths in the components are actually exercised.
// ---------------------------------------------------------------------------

export function pageOf<T>(data: readonly T[]): {
  data: readonly T[];
  nextCursor: null;
} {
  return { data, nextCursor: null };
}
