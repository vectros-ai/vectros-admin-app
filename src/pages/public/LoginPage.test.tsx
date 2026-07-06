// ---------------------------------------------------------------------------
// LoginPage tests.
//
// Strategy: render LoginPage inside a MemoryRouter + AuthProvider with an
// inline mock adapter. Drive form interactions via userEvent + assert on
// the next navigation target / error message / form stage transition.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

import { AuthProvider } from '../../auth';
import { AuthError } from '../../auth';
import type { AuthProviderAdapter, AuthUser, SignInResult, SignUpResult } from '../../auth';
import { LoginPage } from './LoginPage';
import { TestIntlProvider } from '../../test/intl';

function mockAdapter(overrides: Partial<AuthProviderAdapter> = {}): AuthProviderAdapter {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    signIn: vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult),
    confirmSignIn: vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult),
    signUp: vi
      .fn()
      .mockResolvedValue({ kind: 'CONFIRMATION_REQUIRED', method: 'CODE' } satisfies SignUpResult),
    confirmSignUp: vi.fn(),
    resendSignUpCode: vi.fn(),
    forgotPassword: vi.fn(),
    confirmForgotPassword: vi.fn(),
    changePassword: vi.fn(),
    signOut: vi.fn(),
    getIdToken: vi.fn(),
    getMemberships: vi.fn().mockResolvedValue([]),
    getActiveTenant: vi.fn().mockResolvedValue(null),
    getActivePartnerUserId: vi.fn().mockResolvedValue(null),
    setActiveTenant: vi.fn().mockResolvedValue(undefined),
    checkUserExists: vi.fn().mockResolvedValue({ exists: false, isMe: false }),
    linkInvitation: vi
      .fn()
      .mockResolvedValue({
        tenantId: '',
        partnerUserId: '',
        role: 'SUB_USER',
        alreadyActive: false,
      }),
    getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
    setUpTotp: vi
      .fn()
      .mockResolvedValue({
        secret: 'MOCKSECRET234567',
        otpauthUri: 'otpauth://totp/Mock:me?secret=MOCKSECRET234567&issuer=Mock',
      }),
    verifyTotpSetup: vi.fn().mockResolvedValue(undefined),
    disableTotp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const aliceUser: AuthUser = {
  sub: 'sub-1',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
};

function renderLogin(
  provider: AuthProviderAdapter,
  opts: { initialPath?: string; initialState?: unknown } = {},
) {
  return render(
    <TestIntlProvider>
      <MemoryRouter
        initialEntries={[{ pathname: opts.initialPath ?? '/login', state: opts.initialState }]}
      >
        <AuthProvider provider={provider}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>home page</div>} />
            <Route path="/protected" element={<div>protected page</div>} />
            <Route path="/forgot-password" element={<div>forgot page</div>} />
            <Route path="/confirm" element={<div>confirm page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

/**
 * A never-auto-resolving promise + its resolver, so a test can hold an auth
 * call "in flight" and assert the pending button state before completing it.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('LoginPage credentials stage', () => {
  it('renders the sign-in form with email + password fields', () => {
    renderLogin(mockAdapter());
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('enables submit when both fields populated', async () => {
    const user = userEvent.setup();
    renderLogin(mockAdapter());
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('calls signIn with trimmed email and navigates to / on COMPLETE', async () => {
    const user = userEvent.setup();
    const signInSpy = vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult);
    const provider = mockAdapter({
      signIn: signInSpy,
      // After signIn COMPLETE, AuthProvider re-fetches getCurrentUser.
      getCurrentUser: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(aliceUser),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), '  alice@example.com  ');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(signInSpy).toHaveBeenCalledWith({
        email: 'alice@example.com',
        password: 'pw',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('home page')).toBeInTheDocument();
    });
  });

  it('navigates to the original requested location on COMPLETE', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signIn: vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult),
      getCurrentUser: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(aliceUser),
    });
    renderLogin(provider, {
      initialState: { from: { pathname: '/protected' } },
    });
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('protected page')).toBeInTheDocument();
    });
  });

  it('shows the invalid-credentials message on AuthError(INVALID_CREDENTIALS)', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signIn: vi.fn().mockRejectedValue(new AuthError('INVALID_CREDENTIALS', 'native msg')),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText(/email or password you entered is incorrect/i)).toBeInTheDocument();
    });
  });

  it('surfaces the LIMIT_EXCEEDED message verbatim from STRINGS', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signIn: vi.fn().mockRejectedValue(new AuthError('LIMIT_EXCEEDED', 'native msg')),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText(/too many attempts/i)).toBeInTheDocument();
    });
  });

  it('navigates to /confirm when SignInResult is CONFIRMATION_REQUIRED', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signIn: vi.fn().mockResolvedValue({ kind: 'CONFIRMATION_REQUIRED' } satisfies SignInResult),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('confirm page')).toBeInTheDocument();
    });
  });

  it('forgot-password link navigates to /forgot-password', async () => {
    const user = userEvent.setup();
    renderLogin(mockAdapter());
    await user.click(screen.getByRole('link', { name: 'Forgot password?' }));
    await waitFor(() => {
      expect(screen.getByText('forgot page')).toBeInTheDocument();
    });
  });
});

describe('LoginPage MFA stage', () => {
  it('transitions to MFA stage on SignInResult MFA_REQUIRED', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signIn: vi.fn().mockResolvedValue({
        kind: 'MFA_REQUIRED',
        methods: ['TOTP'],
      } satisfies SignInResult),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Verification required' })).toBeInTheDocument();
    });
    expect(screen.getByText(/authenticator app/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/verification code/i)).toBeInTheDocument();
  });

  it('submits the MFA code via confirmSignIn and navigates on COMPLETE', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult);
    const provider = mockAdapter({
      signIn: vi.fn().mockResolvedValue({
        kind: 'MFA_REQUIRED',
        methods: ['TOTP'],
      } satisfies SignInResult),
      confirmSignIn: confirmSpy,
      getCurrentUser: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(aliceUser),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByLabelText(/verification code/i);
    await user.type(screen.getByLabelText(/verification code/i), ' 123456 ');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith({ challengeResponse: '123456' });
    });
    await waitFor(() => {
      expect(screen.getByText('home page')).toBeInTheDocument();
    });
  });

  it('back-to-sign-in returns to the credentials stage and clears MFA error', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signIn: vi.fn().mockResolvedValue({
        kind: 'MFA_REQUIRED',
        methods: ['SMS'],
      } satisfies SignInResult),
      confirmSignIn: vi.fn().mockRejectedValue(new AuthError('CODE_MISMATCH', 'bad code')),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByLabelText(/verification code/i);
    await user.type(screen.getByLabelText(/verification code/i), '999');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(screen.getByText(/code you entered is incorrect/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Accessibility hardening: the submit buttons are now the shared <SubmitButton>, which
// disables + shows a labeled spinner + sets aria-busy while the auth call is
// in flight. These pin that pending state on BOTH stages (a revert to the
// hand-rolled Button would lose aria-busy and fail here). The error path stays
// a plain role="alert" Alert — intentional for this slice (auth-adapter errors
// carry no requestId, so ApiErrorAlert is not used here).
// ---------------------------------------------------------------------------
describe('LoginPage — submit pending state', () => {
  it('credentials: disables the button + shows a labeled spinner while signIn is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<SignInResult>();
    const provider = mockAdapter({ signIn: vi.fn().mockReturnValue(gate.promise) });
    renderLogin(provider);

    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const button = await screen.findByRole('button', { name: 'Signing in…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    gate.resolve({ kind: 'COMPLETE' });
    await waitFor(() => expect(provider.signIn).toHaveBeenCalledTimes(1));
  });

  it('credentials: shows the failure in a role="alert" Alert and re-enables the button', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signIn: vi.fn().mockRejectedValue(new AuthError('INVALID_CREDENTIALS', 'bad')),
    });
    renderLogin(provider);

    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('mfa: disables the verify button + shows the spinner while confirmSignIn is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<SignInResult>();
    const provider = mockAdapter({
      signIn: vi.fn().mockResolvedValue({ kind: 'MFA_REQUIRED', methods: ['TOTP'] }),
      confirmSignIn: vi.fn().mockReturnValue(gate.promise),
    });
    renderLogin(provider);

    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await user.type(await screen.findByLabelText(/verification code/i), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    const button = await screen.findByRole('button', { name: 'Verifying…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    gate.resolve({ kind: 'COMPLETE' });
    await waitFor(() => expect(provider.confirmSignIn).toHaveBeenCalledTimes(1));
  });
});

describe('LoginPage forced-TOTP-setup stage', () => {
  const SETUP = {
    secret: 'SETUPSECRET12345',
    otpauthUri: 'otpauth://totp/Vectros%20Admin?secret=SETUPSECRET12345&issuer=Vectros%20Admin',
  };

  it('renders the enrollment wizard INLINE (no redirect) on TOTP_SETUP_REQUIRED', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signIn: vi
        .fn()
        .mockResolvedValue({ kind: 'TOTP_SETUP_REQUIRED', setup: SETUP } satisfies SignInResult),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The wizard mounts on the login card — we did NOT navigate away.
    expect(
      await screen.findByRole('heading', { name: 'Set up two-factor authentication' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('Authenticator setup QR code')).toBeInTheDocument();
    expect(screen.getByText('SETUPSECRET12345')).toBeInTheDocument();
    // Still on /login (home/protected routes not rendered).
    expect(screen.queryByText('home page')).not.toBeInTheDocument();
  });

  it('completes setup via confirmSignIn(code) and navigates on COMPLETE', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignInResult);
    const provider = mockAdapter({
      signIn: vi
        .fn()
        .mockResolvedValue({ kind: 'TOTP_SETUP_REQUIRED', setup: SETUP } satisfies SignInResult),
      confirmSignIn: confirmSpy,
      getCurrentUser: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(aliceUser),
    });
    renderLogin(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByLabelText(/6-digit code/i);
    await user.type(screen.getByLabelText(/6-digit code/i), '135790');
    await user.click(screen.getByRole('button', { name: /verify & enable/i }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith({ challengeResponse: '135790' });
    });
    await waitFor(() => {
      expect(screen.getByText('home page')).toBeInTheDocument();
    });
  });
});
