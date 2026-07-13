// ---------------------------------------------------------------------------
// App scope-gating integration tests (nav-gating wave surface).
//
// Two client-side authz layers, both exercised here against the SHIPPING
// ADMIN_NAV_ITEMS wiring (incl. the admin:profiles-gated /access/contexts item
// that AppLayout's own package suite omits from its hand-built fixture):
//   1. AppLayout's per-nav-item <ScopeGate> HIDES a sidebar link when the
//      session lacks the gateAction.
//   2. RequireScope guards the gated ROUTES — a deep-link by an under-scoped
//      user is redirected away (see the route-gating describe block below),
//      not merely missing its nav link.
//
// We drive the gate the way production does: register a partner-API token
// minter that returns an st_* token whose `scope.scopes[]` clauses encode the
// caller's effective actions. useScopeGate decodes that — no internal mock of
// the bundled hook — so this exercises decode → can() → ScopeGate / RequireScope
// for real. The token claim shape matches what the scoped-token endpoint mints;
// a flat `allowed_actions` fixture would NOT — and that mismatch is exactly what
// hid an earlier empty-nav regression.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import App from './App';
import { AuthProvider, CurrentTenantProvider } from './auth';
import {
  setPartnerApiTokenMinter,
  __resetVectrosApiTokenCacheForTest,
} from '@vectros-ai/react';
import type { AuthProviderAdapter, AuthUser, TenantMembership } from './auth';
import { TestIntlProvider } from './test/intl';

const TENANT_ID = 'tnt_test_00000000';
const MEMBERSHIPS: ReadonlyArray<TenantMembership> = [
  {
    tenantId: TENANT_ID,
    tenantName: 'Test Org (Test)',
    tenantKind: 'test',
    role: 'OWNER',
    status: 'ACTIVE',
    partnerId: 'ptr_test_0001',
  },
];

const aliceUser: AuthUser = {
  sub: 'sub-1',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
};

function mockAdapter(overrides: Partial<AuthProviderAdapter> = {}): AuthProviderAdapter {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
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
    getMemberships: vi.fn().mockResolvedValue(MEMBERSHIPS),
    getActiveTenant: vi.fn().mockResolvedValue(TENANT_ID),
    getActivePartnerUserId: vi.fn().mockResolvedValue('pu_alice'),
    setActiveTenant: vi.fn().mockResolvedValue(undefined),
    checkUserExists: vi.fn().mockResolvedValue({ exists: false, isMe: false }),
    linkInvitation: vi.fn().mockResolvedValue({ tenantId: '', partnerUserId: '', role: 'SUB_USER', alreadyActive: false }),
    getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
    setUpTotp: vi.fn().mockResolvedValue({ secret: 'MOCKSECRET234567', otpauthUri: 'otpauth://x' }),
    verifyTotpSetup: vi.fn().mockResolvedValue(undefined),
    disableTotp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Build an st_* token carrying `actions` in the real minted shape:
 * `scope.scopes[]` clauses, each with an `allowed_actions` array.
 */
function tokenWithActions(actions: ReadonlyArray<string>): string {
  const payload = btoa(JSON.stringify({ scope: { scopes: [{ allowed_actions: actions }] } }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `st_test_h.${payload}.s`;
}

/** Register a minter that mints a token encoding the given scope. */
function registerScope(actions: ReadonlyArray<string>): ReturnType<typeof vi.fn> {
  const minter = vi
    .fn()
    .mockResolvedValue({ token: tokenWithActions(actions), expiresAtMs: Date.now() + 10 * 60 * 1000 });
  setPartnerApiTokenMinter(minter);
  return minter;
}

function renderApp(provider: AuthProviderAdapter) {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider provider={provider}>
          <CurrentTenantProvider initialTenant={TENANT_ID} initialMemberships={MEMBERSHIPS}>
            <App />
          </CurrentTenantProvider>
        </AuthProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

beforeEach(() => {
  __resetVectrosApiTokenCacheForTest();
});

afterEach(() => {
  vi.clearAllMocks();
  __resetVectrosApiTokenCacheForTest();
});

describe('App nav scope-gating (real gate, shipping ADMIN_NAV_ITEMS)', () => {
  const GATED = [/members/i, /scoped keys/i, /^logs$/i, /disclosures/i, /app contexts/i] as const;

  // The gated nav reveals only after the async mint→decode→gate settles, which
  // can lag the page body on a contended runner (the full suite saturates CPU).
  // findBy's waitFor default is 1s regardless of testTimeout — too tight under
  // load — so wait once with headroom, then assert the rest synchronously (a
  // genuine deny still times out and fails; no masking).
  const GATE_SETTLE_MS = 10_000;

  it('shows ALL gated nav items for a wildcard-scope OWNER', async () => {
    registerScope(['*']);
    renderApp(mockAdapter());

    // The whole nav reveals on the single token mint — wait once for the first
    // gated link, then the rest are present in the same render.
    await screen.findAllByRole('link', { name: GATED[0] }, { timeout: GATE_SETTLE_MS });
    for (const name of GATED) {
      expect(screen.getAllByRole('link', { name }).length).toBeGreaterThan(0);
    }
    expect(screen.queryAllByRole('link', { name: /welcome/i }).length).toBeGreaterThan(0);
  });

  it('first login (sign-in AFTER mount) reveals the gated nav without a page reload', async () => {
    // End-to-end guard for the empty-menu-on-first-login bug. The app mounts
    // UNAUTHENTICATED (RequireAuth → /login) and nothing is seeded, so the
    // tenant provider's initial load sees no session. The user then signs in
    // through the real form. The scope-gated sidebar items must appear off that
    // sign-in ALONE — before the fix, the tenant provider never re-loaded after
    // login, so the active tenant stayed null and the entire gated nav stayed
    // hidden until a full page reload.
    const user = userEvent.setup();
    registerScope(['*']); // OWNER wildcard — every gated item should reveal.

    let signedIn = false;
    const adapter = mockAdapter({
      // Unauthenticated at mount; authenticated only after signIn COMPLETE.
      getCurrentUser: vi.fn().mockImplementation(async () => (signedIn ? aliceUser : null)),
      signIn: vi.fn().mockImplementation(async () => {
        signedIn = true;
        return { kind: 'COMPLETE' as const };
      }),
      // No session → no memberships / active tenant (mirrors the real adapter).
      getMemberships: vi.fn().mockImplementation(async () => (signedIn ? MEMBERSHIPS : [])),
      getActiveTenant: vi.fn().mockImplementation(async () => (signedIn ? TENANT_ID : null)),
    });

    // Rendered UNSEEDED (no initialTenant/initialMemberships) so the real
    // load-on-identity-change path is exercised, unlike renderApp().
    render(
      <TestIntlProvider>
        <MemoryRouter initialEntries={['/login']}>
          <AuthProvider provider={adapter}>
            <CurrentTenantProvider>
              <App />
            </CurrentTenantProvider>
          </AuthProvider>
        </MemoryRouter>
      </TestIntlProvider>,
    );

    // Sign in through the real credentials form.
    await user.type(await screen.findByLabelText(/email address/i), aliceUser.email);
    await user.type(screen.getByLabelText(/^password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The gated nav resolves off the sign-in alone (no reload). Wait once for
    // the first item, then the rest are present in the same render.
    await screen.findAllByRole('link', { name: GATED[0] }, { timeout: GATE_SETTLE_MS });
    for (const name of GATED) {
      expect(screen.getAllByRole('link', { name }).length).toBeGreaterThan(0);
    }
  });

  it('hides EVERY gated nav item for a no-scope sub-user (only un-gated Welcome remains)', async () => {
    const minter = registerScope([]);
    renderApp(mockAdapter());

    // Welcome is un-gated and always present once auth loads.
    expect(await screen.findByRole('heading', { name: 'Welcome, Alice' })).toBeInTheDocument();
    // Ensure the gate actually resolved (minter ran) — not merely still loading.
    await waitFor(() => expect(minter).toHaveBeenCalled());

    for (const name of GATED) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryAllByRole('link', { name: /welcome/i }).length).toBeGreaterThan(0);
  });

  it('pins each gateAction to its item: scope of exactly admin:profiles reveals ONLY the App Contexts link', async () => {
    registerScope(['admin:profiles']);
    renderApp(mockAdapter());

    // Access (admin:profiles) appears — a positive signal the gate resolved.
    expect(
      (await screen.findAllByRole('link', { name: /app contexts/i }, { timeout: GATE_SETTLE_MS }))
        .length,
    ).toBeGreaterThan(0);
    // The other three gated items stay hidden — proves no gateAction-string
    // typo cross-grants (e.g. 'admin:profile' vs 'admin:profiles').
    expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /scoped keys/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^logs$/i })).not.toBeInTheDocument();
  });

  it('grants admin:keys ONLY the Keys link (single-scope sub-user)', async () => {
    registerScope(['admin:keys']);
    renderApp(mockAdapter());

    expect(
      (await screen.findAllByRole('link', { name: /scoped keys/i }, { timeout: GATE_SETTLE_MS }))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^logs$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /app contexts/i })).not.toBeInTheDocument();
  });

  it('grants access-log:r ONLY the Disclosures link (single-scope sub-user)', async () => {
    registerScope(['access-log:r']);
    renderApp(mockAdapter());

    expect(
      (await screen.findAllByRole('link', { name: /disclosures/i }, { timeout: GATE_SETTLE_MS }))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /scoped keys/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^logs$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /app contexts/i })).not.toBeInTheDocument();
  });
});

describe('App route scope-gating (RequireScope enforces gated routes, not just the nav)', () => {
  // Hiding a nav link is cosmetic — the route is still reachable by URL.
  // RequireScope redirects an under-scoped user away from a gated route instead
  // of mounting a page whose API calls would 403. The backend remains the
  // authority; this is the client-side defense-in-depth + UX layer.

  function renderAt(path: string) {
    return render(
      <TestIntlProvider>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider provider={mockAdapter()}>
            <CurrentTenantProvider initialTenant={TENANT_ID} initialMemberships={MEMBERSHIPS}>
              <App />
            </CurrentTenantProvider>
          </AuthProvider>
        </MemoryRouter>
      </TestIntlProvider>,
    );
  }

  it('redirects a no-scope sub-user who deep-links to /members back to Welcome (page not mounted)', async () => {
    registerScope([]);
    renderAt('/members');

    // Redirected to the ungated landing — Welcome renders, the Members page does not.
    expect(await screen.findByRole('heading', { name: 'Welcome, Alice' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Members' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite member' })).not.toBeInTheDocument();
  });

  it('lets a sub-user scoped to admin:users through to the Members page on deep-link', async () => {
    registerScope(['admin:users']);
    renderAt('/members');

    // The route guard allows it through — the Members page itself mounts (its
    // h1, distinct from the nav link of the same name).
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
  });
});
