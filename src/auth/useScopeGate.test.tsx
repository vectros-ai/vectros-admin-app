// ---------------------------------------------------------------------------
// useScopeGate tests.
//
// Pinning:
//   1. Wildcard ["*"] → can(action) true for anything.
//   2. Specific actions → can() matches literally.
//   3. Empty allowed_actions → can() false for everything.
//   4. Loading true until the first mint resolves.
//   5. Token decode handles base64url + missing prefix + bad shape.
//   6. Mint failure → degraded (loading→false, empty allowedActions).
//   7. Re-runs when the tenant override changes.
//
// Strategy: inject a partner-API token MINTER (the cache's new seam) that
// hands back a hand-built st_*-shaped token whose payload we control. The
// tenant override is passed directly (no CurrentTenantProvider needed — the
// override wins over the no-provider fallback).
// ---------------------------------------------------------------------------

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetVectrosApiTokenCacheForTest,
  setPartnerApiTokenMinter,
} from '@vectros-ai/react';
import { __resetScopeGateDecodeCacheForTest, useScopeGate } from '@vectros-ai/react';

const TENANT = 'tnt_test_0001';

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Synthetic st_*-shaped token carrying `actions` in the real minted shape:
 * `scope.scopes[]` is a list of clauses, each with an `allowed_actions` array.
 * (The scoped-token endpoint emits a single clause for these mints.)
 */
function makeStToken(actions: ReadonlyArray<string>, env: 'live' | 'test' = 'test'): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({ scope: { scopes: [{ allowed_actions: actions }] } }),
  );
  return `st_${env}_${header}.${payload}.sig`;
}

/** Register a minter that returns `token` for any tenant. */
function mintToken(token: string): void {
  setPartnerApiTokenMinter(async () => ({ token, expiresAtMs: Date.now() + 900_000 }));
}

beforeEach(() => {
  __resetVectrosApiTokenCacheForTest();
  __resetScopeGateDecodeCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useScopeGate', () => {
  it('starts in loading state and resolves after the token mints', async () => {
    mintToken(makeStToken(['*']));
    const { result } = renderHook(() => useScopeGate(TENANT));

    expect(result.current.loading).toBe(true);
    expect(result.current.allowedActions).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.allowedActions).toEqual(['*']);
  });

  it('grants every action when allowed_actions is wildcard', async () => {
    mintToken(makeStToken(['*']));
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.can('admin:users')).toBe(true);
    expect(result.current.can('anything:at:all')).toBe(true);
  });

  it('grants only listed actions when allowed_actions is specific', async () => {
    mintToken(makeStToken(['admin:users', 'admin:keys']));
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.can('admin:users')).toBe(true);
    expect(result.current.can('admin:keys')).toBe(true);
    expect(result.current.can('admin:logs')).toBe(false);
  });

  it('grants nothing when allowed_actions is empty', async () => {
    mintToken(makeStToken([]));
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.can('admin:users')).toBe(false);
    expect(result.current.can('*')).toBe(false);
  });

  it('decodes the bare JWT shape (no st_<env>_ prefix)', async () => {
    const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
    const payload = base64UrlEncode(
      JSON.stringify({ scope: { scopes: [{ allowed_actions: ['records:r'] }] } }),
    );
    mintToken(`${header}.${payload}.sig`);
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.can('records:r')).toBe(true);
    expect(result.current.can('records:w')).toBe(false);
  });

  it('handles a malformed token by exposing an empty allowedActions list', async () => {
    mintToken('not.a.valid.jwt.at.all');
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.can('admin:users')).toBe(false);
  });

  it('degrades cleanly when the mint fails', async () => {
    setPartnerApiTokenMinter(async () => {
      throw new Error('network down');
    });
    const { result } = renderHook(() => useScopeGate(TENANT));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.allowedActions).toEqual([]);
    expect(result.current.can('admin:users')).toBe(false);
  });

  it('re-runs when the tenant override changes', async () => {
    setPartnerApiTokenMinter(async (tenantId) => ({
      token: makeStToken([tenantId === 'tnt_a' ? 'admin:a_scope' : 'admin:b_scope']),
      expiresAtMs: Date.now() + 900_000,
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
