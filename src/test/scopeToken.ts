// ---------------------------------------------------------------------------
// scopeToken — test-only helper for minting an st_* token carrying a given
// set of allowed_actions (and, optionally, an identity claim), in the REAL
// shape useScopeGate decodes (`scope.scopes[].allowed_actions` +
// `scope.identity`) rather than a flat fixture that would miss a decode-shape
// regression. Extracted from App.scopeGate.test.tsx so a second consumer (a
// page-level action gate, not just nav/route gating) doesn't hand-roll a
// second copy.
// ---------------------------------------------------------------------------

import { vi } from 'vitest';
import { setPartnerApiTokenMinter } from '@vectros-ai/react';

/**
 * Build an st_* token carrying `actions` (and, optionally, `identity`) in the
 * real minted shape: `scope.scopes[]` clauses each with an `allowed_actions`
 * array, plus a sibling `scope.identity` map (canonical `scope:<ns>` keys) —
 * omitted from the payload entirely when absent, matching how an OWNER
 * session's real minted token never carries the key at all.
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
  const payload = btoa(JSON.stringify({ scope }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `st_test_h.${payload}.s`;
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
