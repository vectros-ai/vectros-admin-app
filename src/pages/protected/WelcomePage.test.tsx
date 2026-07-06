// ---------------------------------------------------------------------------
// WelcomePage tests.
//
// Strategy: render WelcomePage inside an AuthProvider with a mock adapter
// that returns a controlled AuthUser. Verify the heading personalizes when
// firstName is present, falls back gracefully when missing, and surfaces
// the user's email + sub for support/verification purposes.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import { AuthProvider } from '../../auth';
import type { AuthProviderAdapter, AuthUser } from '../../auth';
import { WelcomePage } from './WelcomePage';
import { TestIntlProvider } from '../../test/intl';

function mockAdapter(user: AuthUser | null): AuthProviderAdapter {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(user),
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
  };
}

function renderWelcome(user: AuthUser | null) {
  return render(
    <TestIntlProvider>
      <MemoryRouter>
        <AuthProvider provider={mockAdapter(user)}>
          <WelcomePage />
        </AuthProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WelcomePage', () => {
  it('greets the user by first name when present', async () => {
    renderWelcome({
      sub: 'sub-abc',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Welcome, Alice' })).toBeInTheDocument();
    });
  });

  it('falls back to generic Welcome when no first name', async () => {
    renderWelcome({
      sub: 'sub-abc',
      email: 'noname@example.com',
      firstName: null,
      lastName: null,
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Welcome' })).toBeInTheDocument();
    });
  });

  it('shows account card with name, email, and user ID', async () => {
    renderWelcome({
      sub: 'sub-abc-123',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
    });
    await screen.findByRole('heading', { level: 2, name: 'Your account' });
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('sub-abc-123')).toBeInTheDocument();
  });

  it('shows em-dash for the name when neither firstName nor lastName is set', async () => {
    renderWelcome({
      sub: 'sub-abc',
      email: 'noname@example.com',
      firstName: null,
      lastName: null,
    });
    await screen.findByRole('heading', { level: 2, name: 'Your account' });
    // The name field shows the nameUnknown placeholder ('—').
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('handles partial name (only firstName)', async () => {
    renderWelcome({
      sub: 'sub-abc',
      email: 'mono@example.com',
      firstName: 'Mono',
      lastName: null,
    });
    await screen.findByRole('heading', { level: 2, name: 'Your account' });
    expect(screen.getByText('Mono')).toBeInTheDocument();
  });

  it('renders the "What\'s next" card', async () => {
    renderWelcome({
      sub: 'sub-abc',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: "What's next" })).toBeInTheDocument();
    });
    // Post-MR-#7.5 copy: all admin surfaces are live; the What's next
    // card now reads as a recap rather than a "coming soon" promise.
    expect(screen.getByText(/all admin surfaces are now live/i)).toBeInTheDocument();
  });

  it('renders a labeled loading affordance when no user (defensive — RequireAuth normally prevents this)', async () => {
    renderWelcome(null);
    // No page heading in this state — only the loading affordance.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    });
    // The fallback is a screen-reader-labeled spinner (LoadingBlock), not a
    // bare ellipsis with no loading semantics.
    expect(
      screen.getByRole('progressbar', { name: /loading your account/i }),
    ).toBeInTheDocument();
  });

  it('renders the account recap as a dl/dt/dd description list (MetaList semantics)', async () => {
    renderWelcome({
      sub: 'sub-dl-1',
      email: 'dl@example.com',
      firstName: 'Dee',
      lastName: 'Ell',
    });
    await screen.findByRole('heading', { level: 2, name: 'Your account' });
    // The value cells live inside <dd> term-definition elements (MetaRow),
    // so a term-list role is present and the values are reachable as definitions.
    const definitions = document.querySelectorAll('dd');
    const definitionText = Array.from(definitions).map((d) => d.textContent);
    expect(definitionText).toContain('Dee Ell');
    expect(definitionText).toContain('dl@example.com');
    expect(definitionText).toContain('sub-dl-1');
    // And the labels are <dt> terms.
    const terms = Array.from(document.querySelectorAll('dt')).map((t) => t.textContent);
    expect(terms.some((t) => /name/i.test(t ?? ''))).toBe(true);
  });
});
