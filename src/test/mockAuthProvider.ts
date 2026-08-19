// ---------------------------------------------------------------------------
// makeMockAuthProvider — shared test double for AuthProviderAdapter.
//
// Replaces the per-file `mockAdapter()` helpers that each test used to
// duplicate. One source of truth means adding a method to the
// AuthProviderAdapter contract updates every test's mock in one place
// (the multi-tenancy methods — getMemberships/getActiveTenant/
// setActiveTenant/checkUserExists — were added here once, not in nine files).
//
// Every method defaults to a `vi.fn()` with a benign resolved value so a
// component under test never hits an undefined method; pass `overrides` to
// pin the behavior a specific test cares about:
//
//     const auth = makeMockAuthProvider({
//       getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
//     });
//
// Partner-fork note: to test against your own provider you don't need to mock
// its SDK — build a Partial<AuthProviderAdapter> like this and pass it to
// <AuthProvider provider={...}>.
// ---------------------------------------------------------------------------

import { vi } from 'vitest';

import type { AuthProviderAdapter, EmbeddedCredentialAuth, VectrosTenancyProvider } from '../auth';

/** The full shape CognitoAuthProvider implements — admin-app is always this shape. */
export type FullMockProvider = AuthProviderAdapter & EmbeddedCredentialAuth & VectrosTenancyProvider;

export function makeMockAuthProvider(
  overrides: Partial<FullMockProvider> = {},
): FullMockProvider {
  return {
    // Value-returning methods default to a benign "empty" result. signIn /
    // confirmSignIn / signUp have no obvious empty value — a test that drives
    // those flows overrides them; a test that never calls them never trips the
    // bare stub. Void methods resolve so both `await` and `.then()` are safe.
    getCurrentUser: vi.fn().mockResolvedValue(null),
    signIn: vi.fn(),
    confirmSignIn: vi.fn(),
    signUp: vi.fn(),
    confirmSignUp: vi.fn().mockResolvedValue(undefined),
    resendSignUpCode: vi.fn().mockResolvedValue(undefined),
    forgotPassword: vi.fn().mockResolvedValue(undefined),
    confirmForgotPassword: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue(null),
    // Multi-tenancy.
    getMemberships: vi.fn().mockResolvedValue([]),
    getActiveTenant: vi.fn().mockResolvedValue(null),
    getActivePartnerUserId: vi.fn().mockResolvedValue(null),
    setActiveTenant: vi.fn().mockResolvedValue(undefined),
    checkUserExists: vi.fn().mockResolvedValue({ exists: false, isMe: false }),
    linkInvitation: vi
      .fn()
      .mockResolvedValue({ tenantId: '', partnerUserId: '', role: 'SUB_USER', alreadyActive: false }),
    // Multi-factor auth. Default to "no MFA enrolled".
    getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
    setUpTotp: vi
      .fn()
      .mockResolvedValue({ secret: 'MOCKSECRET234567', otpauthUri: 'otpauth://totp/Mock:me?secret=MOCKSECRET234567&issuer=Mock' }),
    verifyTotpSetup: vi.fn().mockResolvedValue(undefined),
    disableTotp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
