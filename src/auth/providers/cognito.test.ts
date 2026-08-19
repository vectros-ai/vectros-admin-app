// ---------------------------------------------------------------------------
// CognitoAuthProvider unit tests.
//
// Mocks `aws-amplify/auth` at the module boundary so the tests exercise the
// adapter logic — argument-shape mapping, sign-in-step normalization,
// metadata → custom:<key> translation — without touching real AWS.
//
// What these tests verify (the contract that survives an Amplify version
// upgrade):
//   - signIn/signUp lowercase the username.
//   - signUp metadata keys are prefixed with `custom:`.
//   - All known Cognito signInStep values map to the right SignInResult.
//   - Unknown signInStep throws (anti-regression for silent fall-through).
//   - signOut uses global sign-out (refresh-token invalidation defense).
//   - getCurrentUser returns null when not signed in (does not throw).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('jose', () => ({ decodeJwt: vi.fn() }));

vi.mock('aws-amplify/auth', () => ({
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signUp: vi.fn(),
  confirmSignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
  resetPassword: vi.fn(),
  confirmResetPassword: vi.fn(),
  updatePassword: vi.fn(),
  signOut: vi.fn(),
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  fetchUserAttributes: vi.fn(),
  setUpTOTP: vi.fn(),
  verifyTOTPSetup: vi.fn(),
  updateMFAPreference: vi.fn(),
  fetchMFAPreference: vi.fn(),
}));

import {
  confirmSignIn as amplifyConfirmSignIn,
  confirmSignUp as amplifyConfirmSignUp,
  fetchAuthSession,
  fetchMFAPreference,
  fetchUserAttributes,
  getCurrentUser as amplifyGetCurrentUser,
  resendSignUpCode as amplifyResendSignUpCode,
  setUpTOTP as amplifySetUpTOTP,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  signUp as amplifySignUp,
  updateMFAPreference,
  verifyTOTPSetup,
} from 'aws-amplify/auth';

import { decodeJwt } from 'jose';

import { AuthError } from '@vectros-ai/react';
import { CognitoAuthProvider } from '@vectros-ai/react/providers/cognito';
import { API_CONFIG } from '../../config';
import { BRAND } from '../../brand';

// Config injected into the provider under test (mirrors main.tsx's wiring).
// Uses the same developer-API base + TOTP issuer the app uses, so the URL and
// issuer assertions below are identical to pre-extraction behavior.
const TEST_PROVIDER_CONFIG = {
  developerApiBase: API_CONFIG.developerApiBase,
  productName: BRAND.productName,
};

const mockSignIn = vi.mocked(amplifySignIn);
const mockConfirmSignIn = vi.mocked(amplifyConfirmSignIn);
const mockSignUp = vi.mocked(amplifySignUp);
const mockConfirmSignUp = vi.mocked(amplifyConfirmSignUp);
const mockResendSignUpCode = vi.mocked(amplifyResendSignUpCode);
const mockSignOut = vi.mocked(amplifySignOut);
const mockGetCurrentUser = vi.mocked(amplifyGetCurrentUser);
const mockFetchAuthSession = vi.mocked(fetchAuthSession);
const mockFetchUserAttributes = vi.mocked(fetchUserAttributes);
const mockDecodeJwt = vi.mocked(decodeJwt);
const mockSetUpTOTP = vi.mocked(amplifySetUpTOTP);
const mockVerifyTOTPSetup = vi.mocked(verifyTOTPSetup);
const mockUpdateMFAPreference = vi.mocked(updateMFAPreference);
const mockFetchMFAPreference = vi.mocked(fetchMFAPreference);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Make getIdToken() resolve to `token` (or null when token is null). */
function stubSession(token: string | null): void {
  mockFetchAuthSession.mockResolvedValue(
    (token === null
      ? { tokens: undefined }
      : { tokens: { idToken: { toString: () => token } } }) as never,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

describe('CognitoAuthProvider.signIn', () => {
  it('lower-cases the username and returns COMPLETE for DONE', async () => {
    mockSignIn.mockResolvedValue({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const result = await adapter.signIn({ email: 'User@Example.COM', password: 'p' });
    expect(mockSignIn).toHaveBeenCalledWith({
      username: 'user@example.com',
      password: 'p',
    });
    expect(result).toEqual({ kind: 'COMPLETE' });
  });

  it('maps TOTP challenge to MFA_REQUIRED with TOTP method', async () => {
    mockSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const result = await adapter.signIn({ email: 'a@b.com', password: 'p' });
    expect(result).toEqual({ kind: 'MFA_REQUIRED', methods: ['TOTP'] });
  });

  it('maps SMS challenge to MFA_REQUIRED with SMS method', async () => {
    mockSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const result = await adapter.signIn({ email: 'a@b.com', password: 'p' });
    expect(result).toEqual({ kind: 'MFA_REQUIRED', methods: ['SMS'] });
  });

  it('maps NEW_PASSWORD_REQUIRED forced change', async () => {
    mockSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const result = await adapter.signIn({ email: 'a@b.com', password: 'p' });
    expect(result).toEqual({ kind: 'NEW_PASSWORD_REQUIRED' });
  });

  it('reads the REAL allowedMFATypes at the MFA-selection step (closes the hardcoding)', async () => {
    mockSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: {
        signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION',
        // Pool offers only TOTP here — the old code hardcoded ['TOTP','SMS'].
        allowedMFATypes: ['TOTP'],
      },
    });
    const result = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).signIn({ email: 'a@b.com', password: 'p' });
    expect(result).toEqual({ kind: 'MFA_REQUIRED', methods: ['TOTP'] });
  });

  it('falls back to [TOTP,SMS] at MFA-selection when the SDK omits allowedMFATypes', async () => {
    mockSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION' },
    });
    const result = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).signIn({ email: 'a@b.com', password: 'p' });
    expect(result).toEqual({ kind: 'MFA_REQUIRED', methods: ['TOTP', 'SMS'] });
  });

  it('maps CONTINUE_SIGN_IN_WITH_TOTP_SETUP to TOTP_SETUP_REQUIRED with the setup details', async () => {
    mockSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: {
        signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
        totpSetupDetails: {
          sharedSecret: 'LOGINSETUPSECRET',
          getSetupUri: (issuer: string) =>
            new URL(`otpauth://totp/${encodeURIComponent(issuer)}?secret=LOGINSETUPSECRET`),
        },
      },
    });
    const result = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).signIn({ email: 'a@b.com', password: 'p' });
    expect(result.kind).toBe('TOTP_SETUP_REQUIRED');
    if (result.kind === 'TOTP_SETUP_REQUIRED') {
      expect(result.setup.secret).toBe('LOGINSETUPSECRET');
      expect(result.setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    }
  });

  it('throws AuthError(UNKNOWN) on an unrecognized signInStep — anti-silent-fall-through guard', async () => {
    // Cast required: the step value is intentionally outside Amplify's typed
    // union to simulate a hypothetical future Amplify version adding a new
    // challenge type. The adapter must reject it rather than silently treating
    // it as DONE.
    mockSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'NEW_AMPLIFY_FUTURE_CHALLENGE' as never },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const rejection = adapter.signIn({ email: 'a@b.com', password: 'p' });
    // AuthError preserves the diagnostic in the message so devs see WHY
    // the adapter rejected even though end users see the generic UNKNOWN.
    await expect(rejection).rejects.toBeInstanceOf(AuthError);
    await expect(rejection).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(rejection).rejects.toThrow(
      /unrecognized sign-in step "NEW_AMPLIFY_FUTURE_CHALLENGE"/,
    );
  });
});

describe('CognitoAuthProvider.confirmSignIn', () => {
  it('passes challengeResponse to Amplify and maps the result', async () => {
    mockConfirmSignIn.mockResolvedValue({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const result = await adapter.confirmSignIn({ challengeResponse: '123456' });
    expect(mockConfirmSignIn).toHaveBeenCalledWith({ challengeResponse: '123456' });
    expect(result).toEqual({ kind: 'COMPLETE' });
  });
});

describe('CognitoAuthProvider.signUp', () => {
  it('translates metadata to custom:<key> attributes', async () => {
    mockSignUp.mockResolvedValue({
      isSignUpComplete: false,
      nextStep: {
        signUpStep: 'CONFIRM_SIGN_UP',
        codeDeliveryDetails: { deliveryMedium: 'EMAIL', attributeName: 'email' },
      },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await adapter.signUp({
      email: 'A@B.com',
      password: 'pw',
      firstName: 'Alice',
      lastName: 'Smith',
      metadata: { invite_token: 'inv_abc', org_hint: 'acme' },
    });
    expect(mockSignUp).toHaveBeenCalledWith({
      username: 'a@b.com',
      password: 'pw',
      options: {
        userAttributes: {
          email: 'a@b.com',
          given_name: 'Alice',
          family_name: 'Smith',
          'custom:invite_token': 'inv_abc',
          'custom:org_hint': 'acme',
        },
      },
    });
  });

  it('omits metadata block when no metadata supplied', async () => {
    mockSignUp.mockResolvedValue({
      isSignUpComplete: false,
      nextStep: {
        signUpStep: 'CONFIRM_SIGN_UP',
        codeDeliveryDetails: { deliveryMedium: 'EMAIL', attributeName: 'email' },
      },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await adapter.signUp({
      email: 'a@b.com',
      password: 'pw',
      firstName: 'A',
      lastName: 'B',
    });
    const callArg = mockSignUp.mock.calls[0]?.[0];
    expect(callArg?.options?.userAttributes).toEqual({
      email: 'a@b.com',
      given_name: 'A',
      family_name: 'B',
    });
  });

  it('returns CONFIRMATION_REQUIRED when signUpStep is CONFIRM_SIGN_UP', async () => {
    mockSignUp.mockResolvedValue({
      isSignUpComplete: false,
      nextStep: {
        signUpStep: 'CONFIRM_SIGN_UP',
        codeDeliveryDetails: { deliveryMedium: 'EMAIL', attributeName: 'email' },
      },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const result = await adapter.signUp({
      email: 'a@b.com',
      password: 'p',
      firstName: 'A',
      lastName: 'B',
    });
    expect(result).toEqual({ kind: 'CONFIRMATION_REQUIRED', method: 'CODE' });
  });

  it('returns COMPLETE when signUpStep is DONE (auto-confirm pools)', async () => {
    mockSignUp.mockResolvedValue({
      isSignUpComplete: true,
      nextStep: { signUpStep: 'DONE' },
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const result = await adapter.signUp({
      email: 'a@b.com',
      password: 'p',
      firstName: 'A',
      lastName: 'B',
    });
    expect(result).toEqual({ kind: 'COMPLETE' });
  });
});

describe('CognitoAuthProvider.confirmSignUp', () => {
  it('lower-cases username and forwards the code', async () => {
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await adapter.confirmSignUp({ email: 'A@B.com', code: '123456' });
    expect(mockConfirmSignUp).toHaveBeenCalledWith({
      username: 'a@b.com',
      confirmationCode: '123456',
    });
  });
});

describe('CognitoAuthProvider.resendSignUpCode', () => {
  it('lower-cases username', async () => {
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await adapter.resendSignUpCode({ email: 'A@B.com' });
    expect(mockResendSignUpCode).toHaveBeenCalledWith({ username: 'a@b.com' });
  });
});

describe('CognitoAuthProvider.signOut', () => {
  it('uses global sign-out to invalidate refresh tokens', async () => {
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await adapter.signOut();
    expect(mockSignOut).toHaveBeenCalledWith({ global: true });
  });
});

describe('CognitoAuthProvider.getCurrentUser', () => {
  it('returns null when no active session (Amplify throws)', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('No current user'));
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const user = await adapter.getCurrentUser();
    expect(user).toBeNull();
  });

  it('returns AuthUser when signed in', async () => {
    mockGetCurrentUser.mockResolvedValue({
      userId: 'sub-1',
      username: 'a@b.com',
    });
    mockFetchUserAttributes.mockResolvedValue({
      sub: 'sub-1',
      email: 'a@b.com',
      given_name: 'Alice',
      family_name: 'Smith',
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const user = await adapter.getCurrentUser();
    expect(user).toEqual({
      sub: 'sub-1',
      email: 'a@b.com',
      firstName: 'Alice',
      lastName: 'Smith',
    });
  });

  it('returns null when sub or email is missing from attributes', async () => {
    mockGetCurrentUser.mockResolvedValue({ userId: 'sub-1', username: 'x' });
    mockFetchUserAttributes.mockResolvedValue({ given_name: 'Only' });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const user = await adapter.getCurrentUser();
    expect(user).toBeNull();
  });

  it('maps missing given_name / family_name to null (not undefined)', async () => {
    mockGetCurrentUser.mockResolvedValue({ userId: 'sub-1', username: 'a@b.com' });
    mockFetchUserAttributes.mockResolvedValue({
      sub: 'sub-1',
      email: 'a@b.com',
    });
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const user = await adapter.getCurrentUser();
    expect(user).toEqual({
      sub: 'sub-1',
      email: 'a@b.com',
      firstName: null,
      lastName: null,
    });
  });
});

describe('CognitoAuthProvider error mapping', () => {
  it('NotAuthorizedException → INVALID_CREDENTIALS (user-enumeration defense)', async () => {
    const amplifyErr = new Error('Incorrect username or password.');
    amplifyErr.name = 'NotAuthorizedException';
    mockSignIn.mockRejectedValue(amplifyErr);
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await expect(adapter.signIn({ email: 'a@b.com', password: 'p' })).rejects.toMatchObject({
      name: 'AuthError',
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('UserNotFoundException → INVALID_CREDENTIALS (user-enumeration defense)', async () => {
    const amplifyErr = new Error('User does not exist.');
    amplifyErr.name = 'UserNotFoundException';
    mockSignIn.mockRejectedValue(amplifyErr);
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const rejection = adapter.signIn({ email: 'a@b.com', password: 'p' });
    await expect(rejection).rejects.toBeInstanceOf(AuthError);
    await expect(rejection).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('UserNotConfirmedException → USER_NOT_CONFIRMED', async () => {
    const amplifyErr = new Error('User is not confirmed.');
    amplifyErr.name = 'UserNotConfirmedException';
    mockSignIn.mockRejectedValue(amplifyErr);
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await expect(adapter.signIn({ email: 'a@b.com', password: 'p' })).rejects.toMatchObject({
      code: 'USER_NOT_CONFIRMED',
    });
  });

  it('LimitExceededException → LIMIT_EXCEEDED', async () => {
    const amplifyErr = new Error('Too many requests.');
    amplifyErr.name = 'LimitExceededException';
    mockSignIn.mockRejectedValue(amplifyErr);
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await expect(adapter.signIn({ email: 'a@b.com', password: 'p' })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
  });

  it('CodeMismatchException → CODE_MISMATCH (via confirmSignUp path)', async () => {
    const amplifyErr = new Error('Invalid verification code provided.');
    amplifyErr.name = 'CodeMismatchException';
    mockConfirmSignUp.mockRejectedValue(amplifyErr);
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await expect(adapter.confirmSignUp({ email: 'a@b.com', code: 'xyz' })).rejects.toMatchObject({
      code: 'CODE_MISMATCH',
    });
  });

  it('unknown error.name → UNKNOWN', async () => {
    const amplifyErr = new Error('Strange new error.');
    amplifyErr.name = 'SomeFutureException';
    mockSignIn.mockRejectedValue(amplifyErr);
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await expect(adapter.signIn({ email: 'a@b.com', password: 'p' })).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });

  it('non-Error rejection → UNKNOWN', async () => {
    mockSignIn.mockRejectedValue('string rejection');
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await expect(adapter.signIn({ email: 'a@b.com', password: 'p' })).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe('CognitoAuthProvider.getIdToken', () => {
  it('returns the idToken string when a session exists', async () => {
    mockFetchAuthSession.mockResolvedValue({
      tokens: {
        idToken: { toString: () => 'eyJ.id.token' },
      },
    } as never);
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const token = await adapter.getIdToken();
    expect(token).toBe('eyJ.id.token');
  });

  it('returns null when no session', async () => {
    mockFetchAuthSession.mockResolvedValue({});
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    const token = await adapter.getIdToken();
    expect(token).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — multi-tenancy methods.
// ---------------------------------------------------------------------------

describe('CognitoAuthProvider.getActiveTenant', () => {
  it('returns the active_tenant claim from the id token', async () => {
    stubSession('id.jwt.token');
    mockDecodeJwt.mockReturnValue({ active_tenant: 'tenant-live-uuid' } as never);
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getActiveTenant()).resolves.toBe('tenant-live-uuid');
  });

  it('returns null when there is no session', async () => {
    stubSession(null);
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getActiveTenant()).resolves.toBeNull();
  });

  it('returns null when the claim is absent', async () => {
    stubSession('id.jwt.token');
    mockDecodeJwt.mockReturnValue({ sub: 'x' } as never);
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getActiveTenant()).resolves.toBeNull();
  });
});

describe('CognitoAuthProvider.getActivePartnerUserId', () => {
  // Mirrors getActiveTenant: the active_partner_user_id claim follows tenant
  // switches and identifies the active membership's principal. Backend
  // re-derives it authoritatively, but a client decode regression is
  // isolation-adjacent, so all four branches are pinned.
  it('returns the active_partner_user_id claim from the id token', async () => {
    stubSession('id.jwt.token');
    mockDecodeJwt.mockReturnValue({ active_partner_user_id: 'pu_1' } as never);
    await expect(
      new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getActivePartnerUserId(),
    ).resolves.toBe('pu_1');
  });

  it('returns null when there is no session', async () => {
    stubSession(null);
    await expect(
      new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getActivePartnerUserId(),
    ).resolves.toBeNull();
  });

  it('returns null when the claim is absent', async () => {
    stubSession('id.jwt.token');
    mockDecodeJwt.mockReturnValue({ sub: 'x' } as never);
    await expect(
      new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getActivePartnerUserId(),
    ).resolves.toBeNull();
  });

  it('returns null for an empty-string claim (treated as absent)', async () => {
    stubSession('id.jwt.token');
    mockDecodeJwt.mockReturnValue({ active_partner_user_id: '' } as never);
    await expect(
      new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getActivePartnerUserId(),
    ).resolves.toBeNull();
  });

  it('returns null when the token decode throws (malformed token)', async () => {
    stubSession('id.jwt.token');
    mockDecodeJwt.mockImplementation(() => {
      throw new Error('malformed');
    });
    await expect(
      new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getActivePartnerUserId(),
    ).resolves.toBeNull();
  });
});

describe('CognitoAuthProvider.setActiveTenant', () => {
  it('POSTs the tenant + force-refreshes when requiresJwtRefresh is true', async () => {
    stubSession('id.jwt.token');
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ tenantId: 't1', requiresJwtRefresh: true }));
    vi.stubGlobal('fetch', fetchSpy);

    await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).setActiveTenant('t1');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${API_CONFIG.developerApiBase}/developer/active-tenant`);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe(JSON.stringify({ tenantId: 't1' }));
    // A forceRefresh call happened (in addition to getIdToken's plain call).
    expect(mockFetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('does NOT force-refresh on a no-op switch (requiresJwtRefresh false)', async () => {
    stubSession('id.jwt.token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ tenantId: 't1', requiresJwtRefresh: false })),
    );
    await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).setActiveTenant('t1');
    expect(mockFetchAuthSession).not.toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('throws on a non-2xx response', async () => {
    stubSession('id.jwt.token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).setActiveTenant('nope')).rejects.toThrow(/404/);
  });
});

describe('CognitoAuthProvider.getMemberships', () => {
  it('maps the developer-API rows to TenantMembership', async () => {
    stubSession('id.jwt.token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([
          {
            tenantId: 'live-uuid',
            tenantName: 'Acme (Live)',
            tenantKind: 'live',
            role: 'OWNER',
            status: 'ACTIVE',
            partnerId: 'p1',
          },
          {
            tenantId: 'test-uuid',
            tenantName: 'Acme (Test)',
            tenantKind: 'test',
            role: 'OWNER',
            status: 'ACTIVE',
            partnerId: 'p1',
          },
        ]),
      ),
    );

    const memberships = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getMemberships();
    expect(memberships).toHaveLength(2);
    expect(memberships[0]).toEqual({
      tenantId: 'live-uuid',
      tenantName: 'Acme (Live)',
      tenantKind: 'live',
      role: 'OWNER',
      status: 'ACTIVE',
      partnerId: 'p1',
    });
    expect(memberships[1]!.tenantKind).toBe('test');
  });

  it('returns [] when there is no session (without fetching)', async () => {
    stubSession(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getMemberships()).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] (not throw) on 401/403', async () => {
    stubSession('id.jwt.token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 403)));
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getMemberships()).resolves.toEqual([]);
  });
});

describe('CognitoAuthProvider.checkUserExists', () => {
  it('reports exists+isMe when the target matches the current session (case-insensitive)', async () => {
    mockGetCurrentUser.mockResolvedValue({ userId: 's1', username: 'me@example.com' });
    mockFetchUserAttributes.mockResolvedValue({ email: 'me@example.com', sub: 's1' });
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).checkUserExists('ME@example.com')).resolves.toEqual({
      exists: true,
      isMe: true,
    });
  });

  it('reports isMe=false when signed in as a different identity', async () => {
    mockGetCurrentUser.mockResolvedValue({ userId: 's2', username: 'bob@example.com' });
    mockFetchUserAttributes.mockResolvedValue({ email: 'bob@example.com', sub: 's2' });
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).checkUserExists('alice@example.com')).resolves.toEqual({
      exists: false,
      isMe: false,
    });
  });

  it('degrades to not-exists when there is no session (no enumeration)', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('no session'));
    await expect(
      new CognitoAuthProvider(TEST_PROVIDER_CONFIG).checkUserExists('someone@example.com'),
    ).resolves.toEqual({ exists: false, isMe: false });
  });
});

describe('CognitoAuthProvider.mintPartnerApiToken', () => {
  it('mints via scoped-token with the env derived from the membership kind', async () => {
    stubSession('id.jwt.token');
    // mintPartnerApiToken calls getMemberships() (to map tenantId→env) then
    // the scoped-token endpoint — branch the fetch mock on the URL.
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/developer/memberships')) {
        return jsonResponse([
          {
            tenantId: 't1',
            tenantName: 'Acme (Test)',
            tenantKind: 'test',
            role: 'OWNER',
            status: 'ACTIVE',
            partnerId: 'p1',
          },
        ]);
      }
      return jsonResponse({ token: 'st_minted', expiresAt: 1700 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).mintPartnerApiToken('t1');
    expect(result).toEqual({ token: 'st_minted', expiresAtMs: 1700 * 1000 });

    const scopedTokenCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('scoped-token'),
    )!;
    expect(String(scopedTokenCall[0])).toContain('tenant=test');
    expect(String(scopedTokenCall[0])).toContain('ttl=900');
    // No contextId supplied → no context param (the server applies its default).
    expect(String(scopedTokenCall[0])).not.toContain('context=');
  });

  it('appends &context=<id> when a context is supplied (admin-app control-plane mint)', async () => {
    stubSession('id.jwt.token');
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/developer/memberships')) {
        return jsonResponse([
          {
            tenantId: 't1',
            tenantName: 'Acme (Test)',
            tenantKind: 'test',
            role: 'OWNER',
            status: 'ACTIVE',
            partnerId: 'p1',
          },
        ]);
      }
      return jsonResponse({ token: 'st_minted', expiresAt: 1700 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).mintPartnerApiToken('t1', 'vectros-admin');

    const scopedTokenCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('scoped-token'),
    )!;
    expect(String(scopedTokenCall[0])).toContain('context=vectros-admin');
  });

  it('throws when not authenticated', async () => {
    stubSession(null);
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).mintPartnerApiToken('t1')).rejects.toThrow(
      /Not authenticated/,
    );
  });
});

describe('CognitoAuthProvider.linkInvitation', () => {
  it('POSTs { invite_token } and maps the response', async () => {
    stubSession('id.jwt.token');
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        tenantId: 'tnt-live-uuid',
        partnerUserId: 'pu-123',
        role: 'SUB_USER',
        alreadyActive: false,
        requiresJwtRefresh: false,
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).linkInvitation('inv_abc');
    expect(result).toEqual({
      tenantId: 'tnt-live-uuid',
      partnerUserId: 'pu-123',
      role: 'SUB_USER',
      alreadyActive: false,
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${API_CONFIG.developerApiBase}/developer/link-invitation`);
    expect((init as RequestInit).method).toBe('POST');
    // Backend field is snake_case `invite_token` (not the camelCase param name).
    expect((init as RequestInit).body).toBe(JSON.stringify({ invite_token: 'inv_abc' }));
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer id.jwt.token',
    });
  });

  it('defaults role→SUB_USER and alreadyActive→false when the backend omits them', async () => {
    stubSession('id.jwt.token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ tenantId: 'tnt-1', partnerUserId: 'pu-1' }),
      ),
    );
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).linkInvitation('inv_x')).resolves.toEqual({
      tenantId: 'tnt-1',
      partnerUserId: 'pu-1',
      role: 'SUB_USER',
      alreadyActive: false,
    });
  });

  it('reports alreadyActive=true (idempotent re-link)', async () => {
    stubSession('id.jwt.token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          tenantId: 'tnt-1',
          partnerUserId: 'pu-1',
          role: 'OWNER',
          alreadyActive: true,
        }),
      ),
    );
    const result = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).linkInvitation('inv_x');
    expect(result.alreadyActive).toBe(true);
    expect(result.role).toBe('OWNER');
  });

  it('throws when not authenticated (without fetching)', async () => {
    stubSession(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).linkInvitation('inv_x')).rejects.toThrow(
      /Not authenticated/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on the uniform 400 (bad/expired token, email mismatch, already-a-member)', async () => {
    stubSession('id.jwt.token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'invalid invitation' }, 400)),
    );
    const rejection = new CognitoAuthProvider(TEST_PROVIDER_CONFIG).linkInvitation('inv_bad');
    await expect(rejection).rejects.toBeInstanceOf(AuthError);
    await expect(rejection).rejects.toThrow(/Failed to link invitation: 400/);
  });
});

// ---------------------------------------------------------------------------
// Multi-factor auth (TOTP).
// ---------------------------------------------------------------------------

describe('CognitoAuthProvider.getMfaStatus', () => {
  it('maps fetchMFAPreference to the normalized MfaStatus', async () => {
    mockFetchMFAPreference.mockResolvedValue({ enabled: ['TOTP'], preferred: 'TOTP' } as never);
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getMfaStatus()).resolves.toEqual({
      enabled: ['TOTP'],
      preferred: 'TOTP',
    });
  });

  it('returns enabled:[] + preferred:null when no MFA is enrolled', async () => {
    mockFetchMFAPreference.mockResolvedValue({} as never);
    await expect(new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getMfaStatus()).resolves.toEqual({
      enabled: [],
      preferred: null,
    });
  });

  it('drops MFA types it does not model (defensive allow-list)', async () => {
    mockFetchMFAPreference.mockResolvedValue({
      enabled: ['TOTP', 'WEBAUTHN'],
      preferred: 'TOTP',
    } as never);
    const status = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).getMfaStatus();
    expect(status.enabled).toEqual(['TOTP']); // WEBAUTHN dropped
  });
});

describe('CognitoAuthProvider.setUpTotp', () => {
  it('provisions a secret + otpauth URI (issuer = brand, account = email)', async () => {
    mockGetCurrentUser.mockResolvedValue({ userId: 's1', username: 'me@example.com' });
    mockFetchUserAttributes.mockResolvedValue({ sub: 's1', email: 'me@example.com' });
    mockSetUpTOTP.mockResolvedValue({
      sharedSecret: 'BASE32SECRET234',
      getSetupUri: (issuer: string, account: string) =>
        new URL(
          `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
            `?secret=BASE32SECRET234&issuer=${encodeURIComponent(issuer)}`,
        ),
    } as never);

    const details = await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).setUpTotp();
    expect(details.secret).toBe('BASE32SECRET234');
    expect(details.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(details.otpauthUri).toContain('secret=BASE32SECRET234');
    // accountName is the signed-in email (URL-encoded).
    expect(details.otpauthUri).toContain('me%40example.com');
  });
});

describe('CognitoAuthProvider.verifyTotpSetup', () => {
  it('verifies the code then makes TOTP the preferred method', async () => {
    mockVerifyTOTPSetup.mockResolvedValue(undefined as never);
    mockUpdateMFAPreference.mockResolvedValue(undefined as never);
    await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).verifyTotpSetup('123456');
    expect(mockVerifyTOTPSetup).toHaveBeenCalledWith({ code: '123456' });
    expect(mockUpdateMFAPreference).toHaveBeenCalledWith({ totp: 'PREFERRED' });
  });

  it('maps a wrong code to AuthError(CODE_MISMATCH) and does NOT set a preference', async () => {
    const err = new Error('Invalid verification code provided.');
    err.name = 'CodeMismatchException';
    mockVerifyTOTPSetup.mockRejectedValue(err);
    const adapter = new CognitoAuthProvider(TEST_PROVIDER_CONFIG);
    await expect(adapter.verifyTotpSetup('000000')).rejects.toMatchObject({ code: 'CODE_MISMATCH' });
    expect(mockUpdateMFAPreference).not.toHaveBeenCalled();
  });
});

describe('CognitoAuthProvider.disableTotp', () => {
  it('disables the TOTP preference', async () => {
    mockUpdateMFAPreference.mockResolvedValue(undefined as never);
    await new CognitoAuthProvider(TEST_PROVIDER_CONFIG).disableTotp();
    expect(mockUpdateMFAPreference).toHaveBeenCalledWith({ totp: 'DISABLED' });
  });
});
