// ---------------------------------------------------------------------------
// App routing smoke tests.
//
// Validates the route table: which page renders for each URL, and whether
// the auth gate fires. Uses MemoryRouter so tests can drive the initial URL.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import App from './App';
import { AuthProvider } from './auth';
import type { AuthProviderAdapter, AuthUser } from './auth';
import { TestIntlProvider } from './test/intl';

function mockAdapter(overrides: Partial<AuthProviderAdapter> = {}): AuthProviderAdapter {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    signIn: vi.fn(),
    confirmSignIn: vi.fn(),
    signUp: vi.fn(),
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
    linkInvitation: vi.fn().mockResolvedValue({ tenantId: '', partnerUserId: '', role: 'SUB_USER', alreadyActive: false }),
    getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
    setUpTotp: vi.fn().mockResolvedValue({ secret: 'MOCKSECRET234567', otpauthUri: 'otpauth://totp/Mock:me?secret=MOCKSECRET234567&issuer=Mock' }),
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

function renderAt(path: string, provider: AuthProviderAdapter) {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider provider={provider}>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('App routing', () => {
  it('renders the LoginPage at /login (no AppLayout)', async () => {
    renderAt('/login', mockAdapter());
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    // Auth-gated AppBar does NOT render on a public route.
    expect(screen.queryByLabelText('Open user menu')).not.toBeInTheDocument();
  });

  it('renders the AcceptPage error state at /accept with no token', async () => {
    renderAt('/accept', mockAdapter());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Invitation problem' }),
    ).toBeInTheDocument();
  });

  it('renders the ConfirmPage error state at /confirm with no ?email', async () => {
    renderAt('/confirm', mockAdapter());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Confirmation problem' }),
    ).toBeInTheDocument();
  });

  it('renders the ForgotPasswordPage at /forgot-password', async () => {
    renderAt('/forgot-password', mockAdapter());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reset your password' }),
    ).toBeInTheDocument();
  });

  it('redirects unauthenticated visitors of / to /login', async () => {
    const provider = mockAdapter({ getCurrentUser: vi.fn().mockResolvedValue(null) });
    renderAt('/', provider);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    });
    expect(screen.queryByText('Welcome placeholder')).not.toBeInTheDocument();
  });

  it('renders Welcome inside AppLayout for authenticated visitors of /', async () => {
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    });
    renderAt('/', provider);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Welcome, Alice' }),
    ).toBeInTheDocument();
    // AppLayout chrome is present on the protected route.
    expect(screen.getByLabelText('Open user menu')).toBeInTheDocument();
    // Skip link is part of AppLayout.
    expect(screen.getByText('Skip to main content')).toBeInTheDocument();
  });

  it('renders the dedicated 404 page for unknown routes', async () => {
    renderAt('/nonexistent', mockAdapter());
    // Catch-all now renders NotFoundPage (chrome-less) instead of redirecting
    // to /. Its "back home" link funnels through
    // RequireAuth for unauth users.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: /page not found/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /back to home/i })).toBeInTheDocument();
  });
});
