// ---------------------------------------------------------------------------
// App scope-gating integration tests (nav-gating wave surface).
//
// Two client-side authz layers, both exercised here against the SHIPPING
// ADMIN_NAV_ITEMS wiring (incl. the app-contexts:r-gated /access/contexts item
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
import { __resetVectrosApiTokenCacheForTest } from '@vectros-ai/react';
import type { AuthUser, TenantMembership } from './auth';
import { makeMockAuthProvider } from './test/mockAuthProvider';
import type { FullMockProvider } from './test/mockAuthProvider';
import { TestIntlProvider } from './test/intl';
import { registerScope } from './test/scopeToken';

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

/** This suite's own defaults (a signed-in owner in TENANT_ID) layered over the shared benign ones. */
function mockAdapter(overrides: Partial<FullMockProvider> = {}): FullMockProvider {
  return makeMockAuthProvider({
    getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    getMemberships: vi.fn().mockResolvedValue(MEMBERSHIPS),
    getActiveTenant: vi.fn().mockResolvedValue(TENANT_ID),
    getActivePartnerUserId: vi.fn().mockResolvedValue('pu_alice'),
    ...overrides,
  });
}

function renderApp(provider: FullMockProvider) {
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
            <CurrentTenantProvider tenancyProvider={adapter}>
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

  it('pins each gateAction to its item: scope of exactly app-contexts:r reveals ONLY the App Contexts link', async () => {
    registerScope(['app-contexts:r']);
    renderApp(mockAdapter());

    // Access (app-contexts:r) appears — a positive signal the gate resolved.
    expect(
      (await screen.findAllByRole('link', { name: /app contexts/i }, { timeout: GATE_SETTLE_MS }))
        .length,
    ).toBeGreaterThan(0);
    // The other three gated items stay hidden — proves no gateAction-string
    // typo cross-grants (e.g. 'app-context:r' vs 'app-contexts:r').
    expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /scoped keys/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^logs$/i })).not.toBeInTheDocument();
  });

  it('grants users:r ONLY the Members link (single-scope sub-user)', async () => {
    registerScope(['users:r']);
    renderApp(mockAdapter());

    expect(
      (await screen.findAllByRole('link', { name: /members/i }, { timeout: GATE_SETTLE_MS }))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /scoped keys/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^logs$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /app contexts/i })).not.toBeInTheDocument();
  });

  it('grants keys:r ONLY the Keys link (single-scope sub-user)', async () => {
    registerScope(['keys:r']);
    renderApp(mockAdapter());

    expect(
      (await screen.findAllByRole('link', { name: /scoped keys/i }, { timeout: GATE_SETTLE_MS }))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /members/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^logs$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /app contexts/i })).not.toBeInTheDocument();
  });

  // F-1 regression lock. `admin:users`/`admin:keys`/`admin:logs`/`admin:profiles`
  // were this app's ORIGINAL gateAction literals — and the platform's scope
  // grammar rejects every one of them at mint time (the post-colon segment must
  // be composed only of single-letter op verbs; none of "users"/"keys"/"logs"/
  // "profiles" qualify). No real credential could ever carry them, which meant
  // every sub-user was silently bounced regardless of their actual grant, and
  // only a wildcard `*` credential ever passed. Assert the legacy shape stays
  // provably inert now that the literals are real grammar, so a future revert
  // back to the `admin:<resource>` spelling fails loudly here instead of
  // shipping a route guard nothing can ever satisfy.
  it('a legacy admin:*-shaped grant (unauthorable server-side) unlocks nothing', async () => {
    const minter = registerScope(['admin:users', 'admin:keys', 'admin:logs', 'admin:profiles']);
    renderApp(mockAdapter());

    expect(await screen.findByRole('heading', { name: 'Welcome, Alice' })).toBeInTheDocument();
    // Ensure the gate actually resolved (minter ran) — not merely still loading,
    // which would make the absences below vacuous.
    await waitFor(() => expect(minter).toHaveBeenCalled());
    for (const name of GATED) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
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

  it('lets a sub-user scoped to users:r through to the Members page on deep-link', async () => {
    registerScope(['users:r']);
    renderAt('/members');

    // The route guard allows it through — the Members page itself mounts (its
    // h1, distinct from the nav link of the same name).
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
  });

  // F-1 regression lock, route level (the nav-gating describe block above
  // covers the same fact at the link-visibility level). Before the fix this
  // registerScope(['admin:users']) fixture minted a token shape the real
  // authorizer can never issue and the test read as proof RequireScope
  // worked — it actually only proved that route-gating logic exists, not
  // that any real credential could satisfy it.
  it('does NOT let a sub-user scoped to the legacy admin:users through — that grant is unauthorable', async () => {
    registerScope(['admin:users']);
    renderAt('/members');

    expect(await screen.findByRole('heading', { name: 'Welcome, Alice' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Members' })).not.toBeInTheDocument();
  });

  // The profile/role ITEM editors gate on `profiles:r`, a DIFFERENT backend
  // resource than the context list/detail routes' `app-contexts:r` — both
  // directions of that mismatch are real bugs (a session with one but not
  // the other is either wrongly redirected away from a page it could use, or
  // let through to one whose own data call then 403s).
  it('redirects a sub-user holding ONLY app-contexts:r away from the profile editor — it needs profiles:r', async () => {
    registerScope(['app-contexts:r']);
    renderAt('/access/contexts/engineering/profiles/usr_alice');

    expect(await screen.findByRole('heading', { name: 'Welcome, Alice' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/loading profiles/i)).not.toBeInTheDocument();
  });

  it('lets a sub-user holding profiles:r through to the profile editor on deep-link', async () => {
    registerScope(['profiles:r']);
    renderAt('/access/contexts/engineering/profiles/usr_alice');

    // The route guard passed the editor through — it starts fetching (its
    // labeled loading state), rather than redirecting to Welcome. This
    // doesn't need a mocked API client: the guard's verdict is decided
    // before any data call happens.
    expect(await screen.findByLabelText(/loading profiles/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome, Alice' })).not.toBeInTheDocument();
  });

  // The CONTEXT DETAIL route (not the item editors above) previously
  // gated on app-contexts:r ALONE, but ContextDetailPage's own Roles/Profiles
  // tab queries need profiles:r — a session holding one but not the other
  // reached a page whose tabs then silently 403'd. The route now requires
  // BOTH, so an under-scoped session is redirected before the page mounts at
  // all rather than landing on a partially-broken one.
  it('redirects a sub-user holding ONLY app-contexts:r away from the context detail page — it also needs profiles:r', async () => {
    registerScope(['app-contexts:r']);
    renderAt('/access/contexts/engineering');

    expect(await screen.findByRole('heading', { name: 'Welcome, Alice' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/loading roles/i)).not.toBeInTheDocument();
  });

  it('redirects a sub-user holding ONLY profiles:r away from the context detail page — it also needs app-contexts:r', async () => {
    registerScope(['profiles:r']);
    renderAt('/access/contexts/engineering');

    expect(await screen.findByRole('heading', { name: 'Welcome, Alice' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/loading roles/i)).not.toBeInTheDocument();
  });

  it('lets a sub-user holding BOTH app-contexts:r and profiles:r through to the context detail page', async () => {
    registerScope(['app-contexts:r', 'profiles:r']);
    renderAt('/access/contexts/engineering');

    // The route guard passed the page through — it starts fetching (its
    // labeled loading state), rather than redirecting to Welcome.
    expect(await screen.findByLabelText(/loading roles/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome, Alice' })).not.toBeInTheDocument();
  });
});
