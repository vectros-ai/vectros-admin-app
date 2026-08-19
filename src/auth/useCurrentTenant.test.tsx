// ---------------------------------------------------------------------------
// useCurrentTenant / useActiveTenantId tests.
//
// The provider now loads real memberships + active tenant from the auth
// adapter (via useAuth) and switches server-side. Pinning:
//   1. Seeded provider exposes the seeded tenant + memberships (no load).
//   2. Async load: memberships + active_tenant claim populate after mount.
//   3. Active-tenant resolution falls back to the first membership when the
//      claim is absent; null when there are no memberships.
//   4. setTenant persists via authProvider.setActiveTenant + switches locally.
//   5. No-provider fallback: inert defaults, no-op setTenant.
//   6. useActiveTenantId returns the tenant inside a provider; throws without one.
// ---------------------------------------------------------------------------

import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@vectros-ai/react';
import { CurrentTenantProvider } from '@vectros-ai/react';
import { useActiveTenantId, useAuth, useCurrentTenant } from '@vectros-ai/react';
import {
  getVectrosApiToken,
  setPartnerApiTokenMinter,
  __resetVectrosApiTokenCacheForTest,
} from '@vectros-ai/react';
import type { AuthUser, TenantMembership } from '@vectros-ai/react';
import { makeMockAuthProvider } from '../test/mockAuthProvider';
import type { FullMockProvider } from '../test/mockAuthProvider';
import { TestIntlProvider } from '../test/intl';

const LIVE: TenantMembership = {
  tenantId: 'tnt_live',
  tenantName: 'Acme (Live)',
  tenantKind: 'live',
  role: 'OWNER',
  status: 'ACTIVE',
  partnerId: 'p1',
};
const TEST: TenantMembership = {
  tenantId: 'tnt_test',
  tenantName: 'Acme (Test)',
  tenantKind: 'test',
  role: 'OWNER',
  status: 'ACTIVE',
  partnerId: 'p1',
};

const ALICE: AuthUser = {
  sub: 'sub-alice',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
};

function wrapper(
  opts: {
    adapter?: FullMockProvider;
    seedTenant?: string;
    seedMemberships?: ReadonlyArray<TenantMembership>;
  } = {},
) {
  const adapter = opts.adapter ?? makeMockAuthProvider();
  // Build props conditionally — exactOptionalPropertyTypes forbids passing
  // explicit `undefined` to optional props.
  const tenantProps: {
    initialTenant?: string;
    initialMemberships?: ReadonlyArray<TenantMembership>;
  } = {};
  if (opts.seedTenant !== undefined) tenantProps.initialTenant = opts.seedTenant;
  if (opts.seedMemberships !== undefined) tenantProps.initialMemberships = opts.seedMemberships;
  return ({ children }: { children: ReactNode }): React.JSX.Element => (
    <TestIntlProvider>
      <AuthProvider provider={adapter}>
        <CurrentTenantProvider tenancyProvider={adapter} {...tenantProps}>
          {children}
        </CurrentTenantProvider>
      </AuthProvider>
    </TestIntlProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetVectrosApiTokenCacheForTest();
});

describe('useCurrentTenant', () => {
  it('exposes the seeded tenant + memberships without loading', () => {
    const { result } = renderHook(() => useCurrentTenant(), {
      wrapper: wrapper({ seedTenant: 'tnt_test', seedMemberships: [LIVE, TEST] }),
    });
    expect(result.current.tenant).toBe('tnt_test');
    expect(result.current.memberships).toHaveLength(2);
    expect(result.current.loading).toBe(false);
    expect(result.current.activeMembership?.tenantKind).toBe('test');
  });

  it('loads memberships + the active_tenant claim on mount', async () => {
    const adapter = makeMockAuthProvider({
      getMemberships: vi.fn().mockResolvedValue([LIVE, TEST]),
      getActiveTenant: vi.fn().mockResolvedValue('tnt_live'),
    });
    const { result } = renderHook(() => useCurrentTenant(), { wrapper: wrapper({ adapter }) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tenant).toBe('tnt_live');
    expect(result.current.memberships).toHaveLength(2);
  });

  it('falls back to the first membership when the active_tenant claim is absent', async () => {
    const adapter = makeMockAuthProvider({
      getMemberships: vi.fn().mockResolvedValue([LIVE, TEST]),
      getActiveTenant: vi.fn().mockResolvedValue(null),
    });
    const { result } = renderHook(() => useCurrentTenant(), { wrapper: wrapper({ adapter }) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tenant).toBe('tnt_live');
  });

  it('ends with no active tenant when the user has no memberships', async () => {
    const adapter = makeMockAuthProvider({
      getMemberships: vi.fn().mockResolvedValue([]),
      getActiveTenant: vi.fn().mockResolvedValue(null),
    });
    const { result } = renderHook(() => useCurrentTenant(), { wrapper: wrapper({ adapter }) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tenant).toBeNull();
    expect(result.current.memberships).toEqual([]);
  });

  it('reloads memberships + active tenant when the user signs in AFTER mount (first login, no reload)', async () => {
    // Regression guard for the empty-menu-on-first-login bug. The provider tree
    // mounts BEFORE sign-in: there is no session, so the initial load reads an
    // empty membership set and the active tenant is null. The user then signs
    // in. The load MUST re-run on that identity change — otherwise the tenant
    // stays null and every scope-gated nav item stays hidden until a full page
    // reload. (Pre-fix, this effect only ran once at mount, so tenant stayed
    // null here.)
    let signedIn = false;
    const adapter = makeMockAuthProvider({
      getCurrentUser: vi.fn().mockImplementation(async () => (signedIn ? ALICE : null)),
      signIn: vi.fn().mockImplementation(async () => {
        signedIn = true;
        return { kind: 'COMPLETE' as const };
      }),
      // Mirror the real adapter: no session → no memberships / no active tenant.
      getMemberships: vi.fn().mockImplementation(async () => (signedIn ? [LIVE, TEST] : [])),
      getActiveTenant: vi.fn().mockImplementation(async () => (signedIn ? 'tnt_live' : null)),
    });

    const { result } = renderHook(
      () => ({ tenant: useCurrentTenant(), auth: useAuth() }),
      { wrapper: wrapper({ adapter }) },
    );

    // Pre-sign-in: the mount load saw no session → no active tenant.
    await waitFor(() => expect(result.current.tenant.loading).toBe(false));
    expect(result.current.tenant.tenant).toBeNull();
    expect(result.current.tenant.memberships).toEqual([]);

    // Sign in — flips the identity; the membership load must re-run.
    await act(async () => {
      await result.current.auth.signIn!({ email: ALICE.email, password: 'pw' });
    });

    // The menu-driving tenant now resolves WITHOUT a reload.
    await waitFor(() => expect(result.current.tenant.tenant).toBe('tnt_live'));
    expect(result.current.tenant.memberships).toHaveLength(2);
  });

  it('setTenant persists via the adapter and switches the active tenant', async () => {
    const setActiveTenant = vi.fn().mockResolvedValue(undefined);
    const adapter = makeMockAuthProvider({ setActiveTenant });
    const { result } = renderHook(() => useCurrentTenant(), {
      wrapper: wrapper({ adapter, seedTenant: 'tnt_test', seedMemberships: [LIVE, TEST] }),
    });
    await act(async () => {
      await result.current.setTenant('tnt_live');
    });
    expect(setActiveTenant).toHaveBeenCalledWith('tnt_live');
    expect(result.current.tenant).toBe('tnt_live');
  });

  it('setTenant clears the partner-API token cache so the old tenant re-mints (cross-tenant bearer-leak guard)', async () => {
    // Behavioral proof of the security-critical clearVectrosApiTokenCache() in
    // CurrentTenantProvider.setTenant: a bearer cached under the PREVIOUS tenant
    // must NOT survive the switch (else the old tenant's token could be handed
    // out under the new one — a cross-tenant data-access leak). We register a
    // minter, populate the cache for tnt_test, switch tenants, then assert a
    // subsequent fetch for tnt_test re-mints rather than returning the stale
    // bearer.
    const farFutureExpiry = Date.now() + 10 * 60 * 1000;
    const minter = vi
      .fn()
      .mockImplementation((tenantId: string) =>
        Promise.resolve({ token: `st_test_${tenantId}_bearer`, expiresAtMs: farFutureExpiry }),
      );
    setPartnerApiTokenMinter(minter);

    const adapter = makeMockAuthProvider({ setActiveTenant: vi.fn().mockResolvedValue(undefined) });
    const { result } = renderHook(() => useCurrentTenant(), {
      wrapper: wrapper({ adapter, seedTenant: 'tnt_test', seedMemberships: [LIVE, TEST] }),
    });

    // Populate the cache for the active tenant — one mint.
    await act(async () => {
      await getVectrosApiToken('tnt_test');
    });
    expect(minter).toHaveBeenCalledTimes(1);

    // A second fetch within the expiry window is a cache HIT (no new mint) —
    // proves the cache is warm before the switch.
    await act(async () => {
      await getVectrosApiToken('tnt_test');
    });
    expect(minter).toHaveBeenCalledTimes(1);

    // Switch tenants — setTenant must clear the cache.
    await act(async () => {
      await result.current.setTenant('tnt_live');
    });

    // The cached tnt_test bearer is gone → this fetch re-mints (2nd call).
    await act(async () => {
      await getVectrosApiToken('tnt_test');
    });
    expect(minter).toHaveBeenCalledTimes(2);
  });

  describe('no-provider fallback', () => {
    it('returns inert defaults', () => {
      const { result } = renderHook(() => useCurrentTenant());
      expect(result.current.tenant).toBeNull();
      expect(result.current.memberships).toEqual([]);
      expect(result.current.loading).toBe(false);
      expect(result.current.activeMembership).toBeNull();
    });

    it('setTenant is a no-op that does not throw', async () => {
      const { result } = renderHook(() => useCurrentTenant());
      await expect(result.current.setTenant('tnt_x')).resolves.toBeUndefined();
    });
  });
});

describe('useActiveTenantId', () => {
  it('returns the active tenant inside a seeded provider', () => {
    const { result } = renderHook(() => useActiveTenantId(), {
      wrapper: wrapper({ seedTenant: 'tnt_test', seedMemberships: [TEST] }),
    });
    expect(result.current).toBe('tnt_test');
  });

  it('throws when there is no active tenant (no provider)', () => {
    // The throw is the guard against rendering a tenant-scoped page outside
    // the AppLayout tenant gate. Silence the expected React render error log.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useActiveTenantId())).toThrow(/no active tenant/);
    spy.mockRestore();
  });
});
