// ---------------------------------------------------------------------------
// scopeToken — test-only helper for minting an st_* token carrying a given
// set of allowed_actions (and, optionally, an identity claim), in the REAL
// shape useScopeGate decodes: a `scope` claim raw-DEFLATE-compressed against
// the platform's preset dictionary — via `__compressScopeClaimForTest`, NOT
// a plain `scope` object. A plain object is the pre-compression shape;
// useScopeGate's decode still accepts it as a defensive fallback, but a
// fixture built on it exercises only that fallback path, never the real
// compressed-decode path. Extracted from App.scopeGate.test.tsx so a second
// consumer (a page-level action gate, not just nav/route gating) doesn't
// hand-roll a second copy.
// ---------------------------------------------------------------------------

import { vi } from 'vitest';
import { setPartnerApiTokenMinter, __compressScopeClaimForTest } from '@vectros-ai/react';

/**
 * Build an st_* token carrying `actions` (and, optionally, `identity`) in the
 * real minted shape: a compressed `scope` claim whose decompressed JSON is
 * `scope.scopes[]` clauses each with an `allowed_actions` array, plus a
 * sibling `scope.identity` map (canonical `scope:<ns>` keys) — omitted from
 * the payload entirely when absent, matching how an OWNER session's real
 * minted token never carries the key at all.
 */
export function tokenWithActions(
  actions: ReadonlyArray<string>,
  identity?: Readonly<Record<string, string>>,
): string {
  const scope: {
    scopes: Array<{ allowed_actions: ReadonlyArray<string> }>;
    identity?: Record<string, string>;
  } = { scopes: [{ allowed_actions: actions }] };
  if (identity && Object.keys(identity).length > 0) {
    scope.identity = { ...identity };
  }
  const compressedScope = __compressScopeClaimForTest(JSON.stringify(scope));
  const payload = btoa(JSON.stringify({ scope: compressedScope }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  // No live/test env infix — the mint side has never produced `st_test_`/`st_live_`,
  // only the bare `st_` prefix (see useScopeGate.ts's decodeScopeClaims doc).
  return `st_h.${payload}.s`;
}

/**
 * Register a minter that mints a token encoding the given scope (and,
 * optionally, identity). `identity` is additive — omit it for the (common)
 * case of a session with none.
 */
export function registerScope(
  actions: ReadonlyArray<string>,
  identity?: Readonly<Record<string, string>>,
): ReturnType<typeof vi.fn> {
  const minter = vi
    .fn()
    .mockResolvedValue({
      token: tokenWithActions(actions, identity),
      expiresAtMs: Date.now() + 10 * 60 * 1000,
    });
  setPartnerApiTokenMinter(minter);
  return minter;
}
