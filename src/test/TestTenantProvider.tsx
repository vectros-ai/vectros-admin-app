// ---------------------------------------------------------------------------
// TestTenantProvider — wraps a tenant-scoped component under test with a
// SEEDED tenant context, so it can call useCurrentTenant()/useActiveTenantId()
// without hitting the network.
//
// CurrentTenantProvider loads memberships from the auth adapter (useAuth) — so
// a tenant-scoped page needs BOTH an <AuthProvider> and
// a CurrentTenantProvider. This helper supplies both: a no-op mock adapter +
// CurrentTenantProvider seeded with `initialMemberships` (which skips the async
// load). Page tests render `<TestTenantProvider><SomePage/></TestTenantProvider>`
// instead of `<CurrentTenantProvider initialTenant="test">`.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';

import { AuthProvider, CurrentTenantProvider } from '../auth';
import type { TenantId, TenantMembership } from '../auth';
import { makeMockAuthProvider } from './mockAuthProvider';

/** A stable test tenant id (a UUID-shaped string; value is opaque to tests). */
export const TEST_TENANT_ID: TenantId = 'tnt_test_00000000';

/** Default seeded memberships: one OWNER membership in the test tenant. */
export const TEST_MEMBERSHIPS: ReadonlyArray<TenantMembership> = [
  {
    tenantId: TEST_TENANT_ID,
    tenantName: 'Test Org (Test)',
    tenantKind: 'test',
    role: 'OWNER',
    status: 'ACTIVE',
    partnerId: 'ptr_test_0001',
  },
];

/**
 * The LIVE counterpart. Note the default above is a `test` tenant — so any
 * feature that behaves differently per tenant kind is, by default, exercised
 * only in its test-tenant shape. Pass `kind="live"` for the other one; a
 * feature that differs should assert both.
 */
export const TEST_LIVE_TENANT_ID: TenantId = 'tnt_live_00000000';

export const TEST_LIVE_MEMBERSHIPS: ReadonlyArray<TenantMembership> = [
  {
    ...TEST_MEMBERSHIPS[0]!,
    // A DISTINCT id, not just a different label: sharing one would make `kind`
    // change the tenant's name and nothing else, so anything keyed on tenant
    // id (a query key, a cache slot, the binding helper's tenant check) could
    // not tell the two apart.
    tenantId: TEST_LIVE_TENANT_ID,
    tenantName: 'Test Org (Live)',
    tenantKind: 'live',
  },
];

interface TestTenantProviderProps {
  readonly children: ReactNode;
  /** Override the active tenant id (defaults to TEST_TENANT_ID). */
  readonly tenant?: TenantId;
  /** Override the seeded memberships (defaults to TEST_MEMBERSHIPS). */
  readonly memberships?: ReadonlyArray<TenantMembership>;
  /**
   * Shorthand for the tenant KIND, when that is all a test needs to vary.
   * Ignored when `memberships` is passed explicitly. Defaults to `'test'`,
   * matching TEST_MEMBERSHIPS.
   */
  readonly kind?: 'live' | 'test';
}

export function TestTenantProvider({
  children,
  tenant,
  memberships,
  kind = 'test',
}: TestTenantProviderProps): React.JSX.Element {
  const seeded =
    memberships ?? (kind === 'live' ? TEST_LIVE_MEMBERSHIPS : TEST_MEMBERSHIPS);
  // Default the ACTIVE tenant to the seeded membership's own id, so `kind`
  // selects a coherent (id, kind) pair rather than leaving the active id
  // pointing at a membership that isn't in the list.
  const activeTenant = tenant ?? seeded[0]?.tenantId ?? TEST_TENANT_ID;
  return (
    <AuthProvider provider={makeMockAuthProvider()}>
      <CurrentTenantProvider initialTenant={activeTenant} initialMemberships={seeded}>
        {children}
      </CurrentTenantProvider>
    </AuthProvider>
  );
}
