// ---------------------------------------------------------------------------
// <AuthProvider> + useAuth integration tests.
//
// These tests use an INLINE mock adapter — no `vi.mock('aws-amplify/auth')`.
// That's the value of the provider abstraction: the context's behavior can
// be validated without touching any specific identity-provider SDK.
// ---------------------------------------------------------------------------

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { AuthProvider } from '@vectros-ai/react';
import { assertEmbeddedAuth, useAuth } from '@vectros-ai/react';
import {
  getVectrosApiToken,
  setPartnerApiTokenMinter,
  __resetVectrosApiTokenCacheForTest,
} from '@vectros-ai/react';
import type {
  AuthContextValue,
  AuthUser,
  EmbeddedCredentialAuth,
  SignInResult,
  SignUpResult,
} from '@vectros-ai/react';
import { makeMockAuthProvider } from '../test/mockAuthProvider';
import type { FullMockProvider } from '../test/mockAuthProvider';

/**
 * This suite tests the PACKAGE's own raw `useAuth()` (unnarrowed — every
 * embedded method is optional there, present only when the passed-in
 * provider implements it). The mock here always does, so narrow once for
 * test ergonomics via `assertEmbeddedAuth` — same pattern (and same reason:
 * a real runtime check, not a bare cast) as admin-app's own
 * `src/auth/index.ts` `useAuth` wrapper (not reused here since this suite
 * deliberately exercises the raw package hook, not the app's narrowed one).
 */
function useFullAuth(): AuthContextValue & EmbeddedCredentialAuth {
  const value = useAuth();
  assertEmbeddedAuth(value);
  return value;
}

/** Build a fully-stubbed adapter; tests override individual methods per case. */
function mockAdapter(overrides: Partial<FullMockProvider> = {}): FullMockProvider {
  return makeMockAuthProvider({
    signIn: vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult),
    confirmSignIn: vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult),
    signUp: vi
      .fn()
      .mockResolvedValue({ kind: 'CONFIRMATION_REQUIRED', method: 'CODE' } satisfies SignUpResult),
    ...overrides,
  });
}

const aliceUser: AuthUser = {
  sub: 'sub-1',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
};

function wrap(provider: FullMockProvider) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <AuthProvider provider={provider}>{children}</AuthProvider>;
  };
}

afterEach(() => {
  vi.clearAllMocks();
  __resetVectrosApiTokenCacheForTest();
});

describe('useAuth', () => {
  it('throws when called outside <AuthProvider>', () => {
    // Suppress React's expected error log during this negative-path test.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useAuth())).toThrow(/must be used inside <AuthProvider>/);
    errorSpy.mockRestore();
  });
});

describe('<AuthProvider> initial-load behavior', () => {
  it('starts in loading=true with user=null, then resolves to no-session', async () => {
    const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(null) });
    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    expect(result.current.loading).toBe(true);
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('populates user from getCurrentUser when a session exists', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.user).toEqual(aliceUser);
    expect(result.current.isAuthenticated).toBe(true);
  });
});

describe('<AuthProvider> signIn flow', () => {
  it('refreshes user state when signIn returns COMPLETE', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi
        .fn()
        // first call: not signed in (initial mount)
        .mockResolvedValueOnce(null)
        // second call: signed in (post-signIn refresh)
        .mockResolvedValueOnce(aliceUser),
      signIn: vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult),
    });
    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let signInResult: SignInResult | undefined;
    await act(async () => {
      signInResult = await result.current.signIn({
        email: 'alice@example.com',
        password: 'pw',
      });
    });

    expect(signInResult).toEqual({ kind: 'COMPLETE' });
    expect(result.current.user).toEqual(aliceUser);
    expect(provider.getCurrentUser).toHaveBeenCalledTimes(2);
  });

  it('does NOT refresh user when signIn returns MFA_REQUIRED', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(null),
      signIn: vi
        .fn()
        .mockResolvedValue({ kind: 'MFA_REQUIRED', methods: ['TOTP'] } satisfies SignInResult),
    });
    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signIn({ email: 'a@b.com', password: 'pw' });
    });

    // Initial-mount call only — no second call from signIn.
    expect(provider.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(result.current.user).toBeNull();
  });
});

describe('<AuthProvider> confirmSignIn flow', () => {
  it('refreshes user state when confirmSignIn returns COMPLETE', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(aliceUser),
      confirmSignIn: vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult),
    });
    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.confirmSignIn({ challengeResponse: '123456' });
    });

    expect(result.current.user).toEqual(aliceUser);
  });
});

describe('<AuthProvider> signOut flow', () => {
  it('clears user state on signOut', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    await waitFor(() => {
      expect(result.current.user).toEqual(aliceUser);
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(provider.signOut).toHaveBeenCalledTimes(1);
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('clears the partner-API token cache on signOut so a stale bearer cannot survive a logout', async () => {
    // Behavioral proof of clearVectrosApiTokenCache() inside AuthProvider.signOut:
    // EVERY sign-out path (explicit click, session-expiry redirect) must drop the
    // cached st_* bearers so the next login on the same browser can't read the
    // prior identity's token. We warm the cache, sign out, then assert a fresh
    // fetch re-mints rather than returning the cached bearer.
    const farFutureExpiry = Date.now() + 10 * 60 * 1000;
    const minter = vi
      .fn()
      .mockImplementation((tenantId: string) =>
        Promise.resolve({ token: `st_test_${tenantId}_bearer`, expiresAtMs: farFutureExpiry }),
      );
    setPartnerApiTokenMinter(minter);

    const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(aliceUser) });
    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    await waitFor(() => {
      expect(result.current.user).toEqual(aliceUser);
    });

    // Warm the cache (one mint), confirm a second call is a cache hit.
    await act(async () => {
      await getVectrosApiToken('tnt_live');
      await getVectrosApiToken('tnt_live');
    });
    expect(minter).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.signOut();
    });

    // Cache was cleared on signOut → the next fetch re-mints.
    await act(async () => {
      await getVectrosApiToken('tnt_live');
    });
    expect(minter).toHaveBeenCalledTimes(2);
  });
});

describe('<AuthProvider> pass-through operations', () => {
  it('forwards signUp to the adapter without touching session state', async () => {
    const signUpSpy = vi.fn().mockResolvedValue({
      kind: 'CONFIRMATION_REQUIRED',
      method: 'CODE',
    } satisfies SignUpResult);
    const provider = mockAdapter({ signUp: signUpSpy });

    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let signUpResult: SignUpResult | undefined;
    await act(async () => {
      signUpResult = await result.current.signUp({
        email: 'b@c.com',
        password: 'pw',
        firstName: 'B',
        lastName: 'C',
        metadata: { invite_token: 'inv_x' },
      });
    });

    expect(signUpSpy).toHaveBeenCalledWith({
      email: 'b@c.com',
      password: 'pw',
      firstName: 'B',
      lastName: 'C',
      metadata: { invite_token: 'inv_x' },
    });
    expect(signUpResult).toEqual({ kind: 'CONFIRMATION_REQUIRED', method: 'CODE' });
  });

  it('forwards getIdToken to the adapter', async () => {
    const provider = mockAdapter({
      getIdToken: vi.fn().mockResolvedValue('eyJ.id.token'),
    });
    const { result } = renderHook(() => useFullAuth(), { wrapper: wrap(provider) });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let token: string | null | undefined;
    await act(async () => {
      token = await result.current.getIdToken();
    });
    expect(token).toBe('eyJ.id.token');
  });
});

describe('children rendering', () => {
  it('renders children once mounted', () => {
    const provider = mockAdapter();
    render(
      <AuthProvider provider={provider}>
        <div>child rendered</div>
      </AuthProvider>,
    );
    expect(screen.getByText('child rendered')).toBeInTheDocument();
  });
});

// Tip for partner forks: to write tests against your own provider, you don't
// need to mock the provider's SDK — just build a Partial<AuthProviderAdapter>
// like above and pass it to <AuthProvider provider={...}>. This is the value
// of the abstraction.
