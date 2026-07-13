// ---------------------------------------------------------------------------
// ContextDetailPage tests.
//
// Pinning:
//   1. Breadcrumb renders from URL ctxId before context data loads
//      (URL-derived; doesn't wait on the network).
//   2. Header renders context name from getAppContext.
//   3. Default tab is Roles (when no ?tab= param).
//   4. ?tab=profiles renders the Profiles tab.
//   5. Switching tabs updates ?tab= in the URL (replace, not push).
//   6. Roles tab: empty state when no roles.
//   7. Roles tab: populated table; Edit action routes to the editor.
//   8. Roles tab: Create button routes to /roles/new.
//   9. Profiles tab: populated table; source chip surfaces role vs inline.
//  10. Profiles tab: identityOverrides count rendering.
//  11. Profiles tab: ?roleId= filter chips render + clear button works.
//  12. Profile principal chip surfaces "User" vs "Key" by prefix.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { ContextDetailPage } from './ContextDetailPage';
import { usePrincipalDirectory, userPrincipalId } from '../../lib/usePrincipalDirectory';
import type * as PrincipalDir from '../../lib/usePrincipalDirectory';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

// The Profiles tab resolves `usr_` principals to user emails; mock the
// directory so the list shows human-readable names deterministically.
vi.mock('../../lib/usePrincipalDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof PrincipalDir>();
  return { ...actual, usePrincipalDirectory: vi.fn() };
});

const DIR_USERS = [{ id: 'alice', email: 'alice@example.com' }];

// ---- fixtures ------------------------------------------------------------

const ENGINEERING_CTX = {
  id: 'tnt_test#engineering',
  contextId: 'engineering',
  name: 'Engineering',
  description: 'Engineering team app',
  createdAt: '2026-05-15T08:00:00Z',
};

const ROLE_ENG_MEMBER = {
  contextId: 'engineering',
  roleId: 'eng-member',
  name: 'Engineering Team Member',
  description: 'Read-only access to engineering data',
  scopes: [{ allowed_actions: ['records:r'] }, { allowed_actions: ['documents:r'] }],
  createdAt: '2026-05-15T09:00:00Z',
  lastModified: '2026-05-20T11:00:00Z',
};

const ROLE_ANALYST = {
  contextId: 'engineering',
  roleId: 'analyst',
  name: 'Analyst',
  description: '',
  scopes: [{ allowed_actions: ['records:r'] }],
  createdAt: '2026-05-16T09:00:00Z',
};

const PROFILE_ALICE_ROLED = {
  contextId: 'engineering',
  principalId: 'usr_alice',
  roleId: 'eng-member',
  status: 'active',
  identityOverrides: { orgId: 'org_eng' } as Record<string, unknown>,
  createdAt: '2026-05-17T09:00:00Z',
};

const PROFILE_BOT_INLINE = {
  contextId: 'engineering',
  principalId: 'key_research-bot',
  scopes: [{ allowed_actions: ['rag:c'] }],
  status: 'active',
  createdAt: '2026-05-18T09:00:00Z',
};

interface MockOverrides {
  getAppContext?: ReturnType<typeof vi.fn>;
  listRoles?: ReturnType<typeof vi.fn>;
  listAccessProfiles?: ReturnType<typeof vi.fn>;
}

function makeMockClient(o: MockOverrides = {}) {
  return {
    auth: {
      getAppContext: o.getAppContext ?? vi.fn().mockResolvedValue(ENGINEERING_CTX),
      listRoles:
        o.listRoles ??
        vi.fn().mockResolvedValue(pageOf([ROLE_ENG_MEMBER, ROLE_ANALYST])),
      listAccessProfiles:
        o.listAccessProfiles ??
        vi.fn().mockResolvedValue(pageOf([PROFILE_ALICE_ROLED, PROFILE_BOT_INLINE])),
    },
  };
}

/** Probe the current URL + search params for navigation assertions. */
function LocationProbe() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  return (
    <>
      <div data-testid="probe-pathname">{location.pathname}</div>
      <div data-testid="probe-search">{searchParams.toString()}</div>
    </>
  );
}

function renderPage(
  opts: {
    client?: ReturnType<typeof makeMockClient>;
    initialUrl?: string;
  } = {},
) {
  const client = opts.client ?? makeMockClient();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  vi.mocked(usePrincipalDirectory).mockReturnValue({
    users: DIR_USERS as never,
    isLoading: false,
    isError: false,
    resolve: (pid: string) => {
      const u = DIR_USERS.find((x) => userPrincipalId(x.id) === pid);
      if (u) return { kind: 'user', label: u.email, hasName: true, principalId: pid, user: u as never, unresolved: false };
      if (pid.startsWith('key_')) return { kind: 'key', label: pid, hasName: false, principalId: pid, unresolved: false };
      if (pid.startsWith('usr_')) return { kind: 'user', label: pid, hasName: false, principalId: pid, unresolved: true };
      return { kind: 'unknown', label: pid, hasName: false, principalId: pid, unresolved: false };
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Legacy <MemoryRouter> — matches production's <BrowserRouter>.
  const utils = render(
    <TestIntlProvider>
      <QueryClientProvider client={queryClient}>
        <TestTenantProvider>
          <MemoryRouter initialEntries={[opts.initialUrl ?? '/access/contexts/engineering']}>
            <Routes>
              <Route
                path="/access/contexts/:ctxId"
                element={
                  <>
                    <ContextDetailPage />
                    <LocationProbe />
                  </>
                }
              />
              {/* Stub routes for the navigations the page makes. */}
              <Route path="/access/contexts" element={<LocationProbe />} />
              <Route path="/access/contexts/:ctxId/roles/new" element={<LocationProbe />} />
              <Route path="/access/contexts/:ctxId/roles/:tplId" element={<LocationProbe />} />
              <Route path="/access/contexts/:ctxId/profiles/new" element={<LocationProbe />} />
              <Route path="/access/contexts/:ctxId/profiles/:principalId" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </TestTenantProvider>
      </QueryClientProvider>
    </TestIntlProvider>,
  );
  return { ...utils, client };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ContextDetailPage', () => {
  it('renders the breadcrumb from URL ctxId immediately, before data loads', () => {
    // Pin a never-resolving getAppContext — breadcrumb still shows.
    renderPage({
      client: makeMockClient({
        getAppContext: vi.fn(() => new Promise(() => undefined)),
      }),
    });
    const breadcrumb = screen.getByLabelText(/^app contexts$/i);
    expect(within(breadcrumb).getByText('App Contexts')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('engineering')).toBeInTheDocument();
  });

  it('renders the context name + description after the fetch resolves', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: /^Engineering$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Engineering team app')).toBeInTheDocument();
  });

  it('defaults to the Roles tab when no ?tab= is set', async () => {
    renderPage();
    // Roles table is in the DOM, profiles table is NOT.
    const table = await screen.findByRole('table', {
      name: /roles/i,
    });
    expect(table).toBeInTheDocument();
    expect(
      screen.queryByRole('table', { name: /access profiles/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the Profiles tab when ?tab=profiles is set in the URL', async () => {
    renderPage({ initialUrl: '/access/contexts/engineering?tab=profiles' });
    const table = await screen.findByRole('table', { name: /access profiles/i });
    expect(table).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /^roles$/i })).not.toBeInTheDocument();
  });

  it('switching tabs updates ?tab= in the URL', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /roles/i });

    await user.click(screen.getByRole('tab', { name: /access profiles/i }));
    expect(screen.getByTestId('probe-search')).toHaveTextContent('tab=profiles');

    await user.click(screen.getByRole('tab', { name: /^roles$/i }));
    expect(screen.getByTestId('probe-search')).toHaveTextContent('tab=roles');
  });

  it('Roles tab: empty state when listRoles returns []', async () => {
    renderPage({
      client: makeMockClient({
        listRoles: vi.fn().mockResolvedValue(pageOf([])),
      }),
    });
    await waitFor(() =>
      expect(
        screen.getByText(/no roles yet/i),
      ).toBeInTheDocument(),
    );
  });

  it('Roles tab: Create button routes to /roles/new', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /roles/i });

    await user.click(screen.getByRole('button', { name: /create role/i }));
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
      '/access/contexts/engineering/roles/new',
    );
  });

  it('Roles tab: Edit action routes to the editor page', async () => {
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole('table', { name: /roles/i });
    const rows = within(table).getAllByRole('row');
    // rows[0] is header; rows[1] is eng-member.
    await user.click(
      within(rows[1]!).getByRole('button', { name: /^edit$/i }),
    );
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
      '/access/contexts/engineering/roles/eng-member',
    );
  });

  it('Profiles tab: source chip surfaces role vs inline', async () => {
    renderPage({ initialUrl: '/access/contexts/engineering?tab=profiles' });
    const table = await screen.findByRole('table', { name: /access profiles/i });
    // Alice is roled → chip says "Role: eng-member"
    expect(within(table).getByText(/role: eng-member/i)).toBeInTheDocument();
    // Bot is inline w/ 1 clause → chip says "Inline (1 clause)"
    expect(within(table).getByText(/inline \(1 clause\)/i)).toBeInTheDocument();
  });

  it('Profiles tab: identityOverrides namespaced values and User/Key chip', async () => {
    renderPage({ initialUrl: '/access/contexts/engineering?tab=profiles' });
    const table = await screen.findByRole('table', { name: /access profiles/i });
    const rows = within(table).getAllByRole('row');
    const aliceRow = rows[1]!;
    const botRow = rows[2]!;
    // Alice's `orgId: org_eng` override reads back canonically as `org: org_eng`;
    // bot has none, shown as an em dash.
    expect(within(aliceRow).getByText('org: org_eng')).toBeInTheDocument();
    expect(within(botRow).getByText('—')).toBeInTheDocument();
    // Principal-type chips.
    expect(within(aliceRow).getByText(/^user$/i)).toBeInTheDocument();
    expect(within(botRow).getByText(/^key$/i)).toBeInTheDocument();
    // Human-readable principal: a user shows their email (with the raw usr_ id
    // beneath it); a key shows its id (no name source).
    expect(within(aliceRow).getByText('alice@example.com')).toBeInTheDocument();
    expect(within(aliceRow).getByText('usr_alice')).toBeInTheDocument();
    expect(within(botRow).getByText('key_research-bot')).toBeInTheDocument();
  });

  it('Profiles tab: ?roleId= filter renders the chip + clear works', async () => {
    const user = userEvent.setup();
    renderPage({
      initialUrl: '/access/contexts/engineering?tab=profiles&roleId=eng-member',
    });
    // Only Alice (roleId=eng-member) is visible; bot (inline) is filtered out.
    const table = await screen.findByRole('table', { name: /access profiles/i });
    expect(within(table).getByText('usr_alice')).toBeInTheDocument();
    expect(within(table).queryByText('key_research-bot')).not.toBeInTheDocument();
    // Filter notice + Clear button.
    expect(
      screen.getByText(/filtered to profiles referencing eng-member/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /clear filter/i }));
    // After clear, both rows show.
    await waitFor(() => {
      const refreshedTable = screen.getByRole('table', { name: /access profiles/i });
      expect(within(refreshedTable).getByText('key_research-bot')).toBeInTheDocument();
    });
  });

  it('Profiles tab: Edit action URL-encodes the principalId suffix', async () => {
    const user = userEvent.setup();
    renderPage({ initialUrl: '/access/contexts/engineering?tab=profiles' });
    const table = await screen.findByRole('table', { name: /access profiles/i });
    const rows = within(table).getAllByRole('row');
    // Bot principal: key_research-bot — has a hyphen, encodeURIComponent
    // leaves it as-is, but the encoding boundary is the pin we want.
    await user.click(
      within(rows[2]!).getByRole('button', { name: /^edit$/i }),
    );
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
      '/access/contexts/engineering/profiles/key_research-bot',
    );
  });

  // ---- hardening: states + a11y -----------------------------------

  it('Roles tab: loading spinner exposes an accessible label', () => {
    renderPage({
      client: makeMockClient({
        listRoles: vi.fn(() => new Promise(() => undefined)),
      }),
    });
    expect(screen.getByLabelText(/loading roles/i)).toBeInTheDocument();
  });

  it('Profiles tab: loading spinner exposes an accessible label', () => {
    renderPage({
      initialUrl: '/access/contexts/engineering?tab=profiles',
      client: makeMockClient({
        listAccessProfiles: vi.fn(() => new Promise(() => undefined)),
      }),
    });
    expect(screen.getByLabelText(/loading profiles/i)).toBeInTheDocument();
  });

  it('shows an accessible (role="alert") context-meta error when getAppContext fails', async () => {
    renderPage({
      client: makeMockClient({
        getAppContext: vi.fn().mockRejectedValue(
          new VectrosError({ message: 'no ctx', statusCode: 404 }),
        ),
      }),
    });
    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((a) => /could not load this app context/i.test(a.textContent ?? '')),
    ).toBe(true);
    // The header still falls back to the raw ctxId for orientation.
    expect(
      screen.getByRole('heading', { level: 1, name: /^engineering$/i }),
    ).toBeInTheDocument();
  });

  it('Roles tab: shows an accessible error when listRoles fails', async () => {
    renderPage({
      client: makeMockClient({
        listRoles: vi.fn().mockRejectedValue(
          new VectrosError({ message: 'down', statusCode: 503 }),
        ),
      }),
    });
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(
        alerts.some((a) => /could not load roles/i.test(a.textContent ?? '')),
      ).toBe(true);
    });
  });

  it('Roles tab: surfaces the requestId from the error body', async () => {
    renderPage({
      client: makeMockClient({
        listRoles: vi.fn().mockRejectedValue(
          new VectrosError({
            message: 'down',
            statusCode: 503,
            body: { message: 'down', requestId: 'req_roles_42' },
          }),
        ),
      }),
    });
    expect(await screen.findByText(/req_roles_42/)).toBeInTheDocument();
  });

  it('Profiles tab: ?roleId= filter that matches nothing shows a distinct filtered-empty state', async () => {
    renderPage({
      initialUrl: '/access/contexts/engineering?tab=profiles&roleId=does-not-exist',
    });
    // The context HAS profiles, but none reference the filtered role → the
    // distinct "no profiles reference …" copy, not the generic empty state.
    expect(
      await screen.findByText(/no access profiles reference does-not-exist/i),
    ).toBeInTheDocument();
  });

  it('keyboard: Enter on a focused role row opens the editor', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: /roles/i });
    const row = screen.getByRole('row', { name: /open role eng-member/i });
    row.focus();
    expect(row).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
      '/access/contexts/engineering/roles/eng-member',
    );
  });

  it('keyboard: Enter on a focused profile row opens the editor', async () => {
    const user = userEvent.setup();
    renderPage({ initialUrl: '/access/contexts/engineering?tab=profiles' });
    await screen.findByRole('table', { name: /access profiles/i });
    const row = screen.getByRole('row', { name: /open access profile for usr_alice/i });
    row.focus();
    expect(row).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
      '/access/contexts/engineering/profiles/usr_alice',
    );
  });
});
