// ---------------------------------------------------------------------------
// useScopeGate tests.
//
// Pinning:
//   1. Wildcard ["*"] → can(action) true for anything.
//   2. Specific actions → can() matches literally.
//   3. Empty allowed_actions → can() false for everything.
//   4. Loading true until the first mint resolves.
//   5. A minter that supplies no resolvedScope (older backend, or a fork
//      mid-migration) degrades to empty rather than throwing.
//   6. Mint failure → degraded (loading→false, empty allowedActions).
//   7. Re-runs when the tenant override changes.
//
// Strategy: inject a partner-API token MINTER (the cache's own seam) that
// resolves to a mint response carrying the given actions/identity as
// `resolvedScope` — the shape useScopeGate reads directly now,
// replacing the old client-decoded compressed-`scope`-claim token this file
// used to hand-build. The tenant override is passed directly (no
// CurrentTenantProvider needed — the override wins over the no-provider
// fallback).
// ---------------------------------------------------------------------------

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetVectrosApiTokenCacheForTest, setPartnerApiTokenMinter, useScopeGate } from '@vectros-ai/react';

const TENANT = 'tnt_test_0001';

/** Register a minter that resolves `actions` (and, optionally, `identity`) as resolvedScope. */
function mintScope(actions: ReadonlyArray<string>, identity: Readonly<Record<string, string>> = {}): void {
  setPartnerApiTokenMinter(async () => ({
    token: 'st_test_opaque',
    expiresAtMs: Date.now() + 900_000,
    resolvedScope: { allowedActions: actions, identity },
  }));
}

beforeEach(() => {
  __resetVectrosApiTokenCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useScopeGate', () => {
  it('starts in loading state and resolves after the token mints', async () => {
    mintScope(['*']);
    const { result } = renderHook(() => useScopeGate(TENANT));

    expect(result.current.loading).toBe(true);
    expect(result.current.allowedActions).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.allowedActions).toEqual(['*']);
  });

  it('grants every action when allowed_actions is wildcard', async () => {
    mintScope(['*']);
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.can('admin:users')).toBe(true);
    expect(result.current.can('anything:at:all')).toBe(true);
  });

  it('grants only listed actions when allowed_actions is specific', async () => {
    mintScope(['admin:users', 'admin:keys']);
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.can('admin:users')).toBe(true);
    expect(result.current.can('admin:keys')).toBe(true);
    expect(result.current.can('admin:logs')).toBe(false);
  });

  it('grants nothing when allowed_actions is empty', async () => {
    mintScope([]);
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.can('admin:users')).toBe(false);
    expect(result.current.can('*')).toBe(false);
  });

  it('surfaces the resolved identity alongside allowedActions', async () => {
    mintScope(['profiles:r'], { userId: 'usr_1', 'scope:org': 'org_a' });
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.identity).toEqual({ userId: 'usr_1', 'scope:org': 'org_a' });
  });

  it('degrades to empty (not throw) when the minter supplies no resolvedScope at all', async () => {
    // A fork mid-migration, or an older backend response shape — the mint
    // itself still succeeds, but nothing to gate on came back.
    setPartnerApiTokenMinter(async () => ({ token: 'st_no_scope', expiresAtMs: Date.now() + 900_000 }));
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.identity).toEqual({});
    expect(result.current.can('admin:users')).toBe(false);
  });

  it('degrades cleanly when the mint fails', async () => {
    setPartnerApiTokenMinter(async () => {
      throw new Error('network down');
    });
    const { result } = renderHook(() => useScopeGate(TENANT));
    // getVectrosApiToken retries once on a genuine mint failure (~1.5s shared
    // delay) before surfacing the error — see vectrosApiTokenCache.ts's own
    // SHARED_MINT_RETRY_DELAY_MS — so this needs a longer wait than the default.
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 3000 });

    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.can('admin:users')).toBe(false);
  });

  it('re-runs when the tenant override changes', async () => {
    setPartnerApiTokenMinter(async (tenantId) => ({
      token: 'st_test_opaque',
      expiresAtMs: Date.now() + 900_000,
      resolvedScope: {
        allowedActions: [tenantId === 'tnt_a' ? 'admin:a_scope' : 'admin:b_scope'],
        identity: {},
      },
    }));
    const { result, rerender } = renderHook(({ tid }: { tid: string }) => useScopeGate(tid), {
      initialProps: { tid: 'tnt_a' },
    });
    await waitFor(() => expect(result.current.can('admin:a_scope')).toBe(true));

    rerender({ tid: 'tnt_b' });
    await waitFor(() => expect(result.current.can('admin:b_scope')).toBe(true));
    expect(result.current.can('admin:a_scope')).toBe(false);
  });
});
