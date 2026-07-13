// ---------------------------------------------------------------------------
// scopeNamespace — grammar + validation for custom ownership-scope namespaces.
//
// An owned item carries its owning user plus up to two namespaced scope values.
// A namespace is the key half of a `scope:<namespace>` dimension: 2–32 chars,
// a lowercase letter first, then lowercase letters, digits, `_` or `-`.
// `org` and `client` are the two built-in namespaces (`scope:org` / `scope:client`,
// with `orgId` / `clientId` accepted as write-time shorthand); `user`, `self`,
// `tenant`, `context`, and `scope` are reserved and rejected.
//
// Pure (no React) so mutation builders, the scope editors, and tests all
// validate the exact same shape the platform enforces.
// ---------------------------------------------------------------------------

/** A namespace is a lowercase letter followed by 1–31 of `[a-z0-9_-]` (2–32 total). */
export const SCOPE_NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

/** The two built-in namespaces. Selectable everywhere a namespace is authored. */
export const SCOPE_BUILTIN_NAMESPACES = ['org', 'client'] as const;

/** Reserved namespaces the platform rejects. */
export const SCOPE_RESERVED_NAMESPACES = [
  'user',
  'self',
  'tenant',
  'context',
  'scope',
] as const;

/** An owned item may carry at most this many scope namespaces. */
export const MAX_SCOPE_NAMESPACES = 2;

/** Canonical wire prefix for a namespaced scope dimension key. */
export const SCOPE_KEY_PREFIX = 'scope:';

/** Structured namespace-validation error. `code` is stable for custom copy. */
export type ScopeNamespaceError =
  | { readonly code: 'empty' }
  | { readonly code: 'grammar' }
  | { readonly code: 'reserved'; readonly namespace: string };

/**
 * Validate a single namespace against the platform grammar + reserved list.
 * Returns null when valid. `org` / `client` are valid (built-ins); the reserved
 * names are rejected. Callers that forbid the built-ins in a given surface
 * (e.g. an "additional scopes" list that already has dedicated org/client
 * fields) layer that check on top of this one.
 */
export function validateScopeNamespace(
  namespace: string,
): ScopeNamespaceError | null {
  const ns = namespace.trim();
  if (ns === '') return { code: 'empty' };
  if ((SCOPE_RESERVED_NAMESPACES as readonly string[]).includes(ns)) {
    return { code: 'reserved', namespace: ns };
  }
  if (!SCOPE_NAMESPACE_PATTERN.test(ns)) return { code: 'grammar' };
  return null;
}

/** The canonical `scope:<namespace>` key for a namespace. */
export function scopeKey(namespace: string): string {
  return `${SCOPE_KEY_PREFIX}${namespace}`;
}

/**
 * Extract the bare namespace from a canonical `scope:<namespace>` key, or null
 * if the key isn't in that form. `scope:org` → `org`; `orgId` → null.
 */
export function namespaceFromScopeKey(key: string): string | null {
  if (!key.startsWith(SCOPE_KEY_PREFIX)) return null;
  const ns = key.slice(SCOPE_KEY_PREFIX.length);
  return ns === '' ? null : ns;
}
