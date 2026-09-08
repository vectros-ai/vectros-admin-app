// ---------------------------------------------------------------------------
// scopeToken — test-only helper for registering a minter that resolves the
// given allowed_actions (and, optionally, an identity claim) as the mint
// response's server-resolved `resolvedScope` field — the shape
// `useScopeGate` reads directly now. The token string itself is opaque to
// the frontend (nothing decodes it anymore); a fixed placeholder is fine.
// Extracted from App.scopeGate.test.tsx so a second consumer (a page-level
// action gate, not just nav/route gating) doesn't hand-roll a second copy.
// ---------------------------------------------------------------------------

import { vi } from 'vitest';
import { setPartnerApiTokenMinter } from '@vectros-ai/react';

/**
 * Register a minter that resolves to a mint response carrying `actions` (and,
 * optionally, `identity`) as `resolvedScope`. `identity` is additive — omit
 * it for the (common) case of a session with none.
 */
export function registerScope(
  actions: ReadonlyArray<string>,
  identity?: Readonly<Record<string, string>>,
): ReturnType<typeof vi.fn> {
  const minter = vi.fn().mockResolvedValue({
    token: 'st_test_opaque',
    expiresAtMs: Date.now() + 10 * 60 * 1000,
    resolvedScope: { allowedActions: [...actions], identity: identity ? { ...identity } : {} },
  });
  setPartnerApiTokenMinter(minter);
  return minter;
}
