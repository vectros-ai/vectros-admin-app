// ---------------------------------------------------------------------------
// TestTenantProvider — wraps a tenant-scoped component under test with a
// SEEDED tenant context, so it can call useCurrentTenant()/useActiveTenantId()
// without hitting the network.
//
// Post-MR-#8-Phase-7, CurrentTenantProvider loads memberships from the auth
// adapter (useAuth) — so a tenant-scoped page needs BOTH an <AuthProvider> and
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

interface TestTenantProviderProps {
  readonly children: ReactNode;
  /** Override the active tenant id (defaults to TEST_TENANT_ID). */
  readonly tenant?: TenantId;
  /** Override the seeded memberships (defaults to TEST_MEMBERSHIPS). */
  readonly memberships?: ReadonlyArray<TenantMembership>;
}

export function TestTenantProvider({
  children,
  tenant = TEST_TENANT_ID,
  memberships = TEST_MEMBERSHIPS,
}: TestTenantProviderProps): React.JSX.Element {
  return (
    <AuthProvider provider={makeMockAuthProvider()}>
      <CurrentTenantProvider initialTenant={tenant} initialMemberships={memberships}>
        {children}
      </CurrentTenantProvider>
    </AuthProvider>
  );
}
