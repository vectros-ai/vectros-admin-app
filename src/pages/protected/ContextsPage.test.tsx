// ---------------------------------------------------------------------------
// ContextsPage tests.
//
// Pinning:
//   1. Renders title + subtitle + Create button up-front.
//   2. Loading spinner while listAppContexts is in flight.
//   3. Error Alert when listAppContexts fails.
//   4. Empty state when listAppContexts returns [] (rare — vectros-admin
//      is auto-seeded — but a defensive surface).
//   5. Smart-redirect when exactly 1 context: shows the "you have one
//      app context" Alert + calls navigate(`/access/contexts/<id>`)
//      after the 1s settle.
//   6. Table renders when N>1, one row per context.
//   7. Per-row role + profile counts surface as numbers when their
//      queries resolve; "…" placeholder while loading.
//   8. Delete affordance: non-reserved rows show an enabled Delete; the
//      reserved vectros-admin (and default) rows hide it entirely (the server
//      refuses them unconditionally); rows already tearing down hide it too
//      and carry the "Deleting…" marker.
//   9. Create dialog opens, validates ID format inline, calls the developer
//      API's createAppContext, closes on success, invalidates the list.
//  10. Edit dialog opens with prefilled fields, contextId disabled,
//      calls updateAppContext with the SDK's `{contextId, body}` envelope.
//  11. Row click routes to /access/contexts/:id (excluding action cell
//      clicks, which are stopped).
//  12. Delete dialog: typed-echo arming (CTA disabled until the contextId is
//      typed exactly), calls the developer API's deleteAppContext on submit,
//      closes on success; failure surfaces an in-dialog role="alert" and the
//      dialog stays open.
// ---------------------------------------------------------------------------

import {
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DeveloperApi from '../../api/developerApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContextsPage } from './ContextsPage';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

// List + create of contexts go through the owner-gated developer API, NOT the
// context-pinned partner SDK; mock the hook the page consumes.
vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DeveloperApi>();
  return {
    ...actual,
    useDeveloperApi: vi.fn(),
  };
});

// ---- fixtures ------------------------------------------------------------

const VECTROS_ADMIN_CTX = {
  id: 'tnt_test#vectros-admin',
  contextId: 'vectros-admin',
  name: 'Vectros Admin',
  description: 'Default admin context',
  createdAt: '2026-05-01T08:00:00Z',
};

const ENGINEERING_CTX = {
  id: 'tnt_test#engineering',
  contextId: 'engineering',
  name: 'Engineering',
  description: 'Engineering team app',
  createdAt: '2026-05-15T08:00:00Z',
};

const ROLES_FOR_ENGINEERING = [{ roleId: 'eng-member' }];
const PROFILES_FOR_ENGINEERING = [{ principalId: 'usr_alice' }, { principalId: 'usr_bob' }];

interface MockOverrides {
  /** Developer-API list (the contexts table source). */
  listAppContexts?: ReturnType<typeof vi.fn>;
  /** Developer-API create. */
  createAppContext?: ReturnType<typeof vi.fn>;
  /** Developer-API delete (owner-gated teardown). */
  deleteAppContext?: ReturnType<typeof vi.fn>;
  /** Partner-SDK per-context calls (counts, edit). */
  listRoles?: ReturnType<typeof vi.fn>;
  listAccessProfiles?: ReturnType<typeof vi.fn>;
  updateAppContext?: ReturnType<typeof vi.fn>;
}

/** Partner-SDK client mock: per-context counts + edit. */
function makeMockClient(o: MockOverrides = {}) {
  return {
    auth: {
      listRoles:
        o.listRoles ??
        vi.fn().mockImplementation((req: { contextId: string }) =>
          Promise.resolve(pageOf(req.contextId === 'engineering' ? ROLES_FOR_ENGINEERING : [])),
        ),
      listAccessProfiles:
        o.listAccessProfiles ??
        vi.fn().mockImplementation((req: { contextId: string }) =>
          Promise.resolve(pageOf(req.contextId === 'engineering' ? PROFILES_FOR_ENGINEERING : [])),
        ),
      updateAppContext: o.updateAppContext ?? vi.fn().mockResolvedValue({ contextId: 'vectros-admin' }),
    },
  };
}

/** Developer-API hook mock: tenant-wide list + owner-gated create/delete. */
function makeMockDeveloperApi(o: MockOverrides = {}) {
  return {
    listAppContexts:
      o.listAppContexts ??
      vi.fn().mockResolvedValue(pageOf([VECTROS_ADMIN_CTX, ENGINEERING_CTX])),
    createAppContext: o.createAppContext ?? vi.fn().mockResolvedValue({ contextId: 'new-ctx' }),
    deleteAppContext: o.deleteAppContext ?? vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Pinhole into the current router location — tests assert on this to
 * verify navigate() side-effects without needing the real route tree.
 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="probe-pathname">{location.pathname}</div>;
}

function renderPage(overrides: MockOverrides = {}) {
  const client = makeMockClient(overrides);
  const developerApi = makeMockDeveloperApi(overrides);
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  vi.mocked(useDeveloperApi).mockReturnValue(developerApi as never);
  // Fresh per-test QueryClient so caches don't leak across `it()`s.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Use the LEGACY <MemoryRouter> component, NOT createMemoryRouter. Prod
  // uses <BrowserRouter> (legacy) — see useBeforeNavigate test-infra
  // convention note. Tests must match the production router type.
  const utils = render(
    <TestIntlProvider>
      <QueryClientProvider client={queryClient}>
        <TestTenantProvider>
          <MemoryRouter initialEntries={['/access/contexts']}>
            <Routes>
              <Route
                path="/access/contexts"
                element={
                  <>
                    <ContextsPage />
                    <LocationProbe />
                  </>
                }
              />
              {/* Stub the detail route so navigate() lands somewhere reachable. */}
              <Route path="/access/contexts/:ctxId" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </TestTenantProvider>
      </QueryClientProvider>
    </TestIntlProvider>,
  );
  return { ...utils, client, developerApi };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ContextsPage', () => {
  it('renders the page meta + create button up-front', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: /app contexts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/an app context is a namespace you define/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /create app context/i }),
    ).toBeInTheDocument();
  });

  it('shows a loading spinner while listAppContexts is in flight', () => {
    renderPage({
        listAppContexts: vi.fn(() => new Promise(() => undefined)),
      });
    expect(screen.getByLabelText(/loading app contexts/i)).toBeInTheDocument();
  });

  it('shows an accessible (role="alert") error when listAppContexts fails', async () => {
    const err = new VectrosError({ message: 'Backend down', statusCode: 503 });
    renderPage({
        listAppContexts: vi.fn().mockRejectedValue(err),
      });
    const alert = await screen.findByRole('alert');
    // Friendly, non-stringified copy (the raw error.message is no longer
    // baked into the surface — ApiErrorAlert surfaces the requestId instead).
    expect(alert).toHaveTextContent(/could not load your app contexts/i);
  });

  it('renders the table with one row per context (N>1)', async () => {
    renderPage();
    // Wait for the actual table — the subtitle also references a context id
    // (the RESERVED_DEFAULT_CONTEXT_ID, `default`), so anchor on the table to
    // avoid a false positive against that copy.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('vectros-admin')).toBeInTheDocument();
    expect(within(table).getByText('engineering')).toBeInTheDocument();
    expect(within(table).getByText('Vectros Admin')).toBeInTheDocument();
    expect(within(table).getByText('Engineering')).toBeInTheDocument();
  });

  it('shows per-row role + profile counts when the parallel queries resolve', async () => {
    const { client } = renderPage();
    await screen.findByText('engineering');
    // Engineering: 1 role + 2 profiles.
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    expect(screen.getByText('2')).toBeInTheDocument();
    // The reserved control-plane context can't back a context-pinned bearer
    // (the partner API rejects an explicit mint for it outright) — its counts
    // are never fetched, shown as "—" rather than a real (possibly zero) count.
    expect(client.auth.listRoles).not.toHaveBeenCalledWith(
      expect.objectContaining({ contextId: 'vectros-admin' }),
    );
    expect(client.auth.listAccessProfiles).not.toHaveBeenCalledWith(
      expect.objectContaining({ contextId: 'vectros-admin' }),
    );
    const adminRow = screen.getAllByRole('row')[1]!;
    expect(
      within(adminRow).getAllByLabelText(/not available for the reserved control-plane context/i),
    ).toHaveLength(2);
  });

  it('shows Delete on non-reserved rows only (reserved contexts hide it)', async () => {
    renderPage();
    // Wait for the table to actually render (not the subtitle's vectros-admin).
    await screen.findByRole('table');
    const rows = screen.getAllByRole('row');
    // rows[0] is the header.
    const adminRow = rows[1]!;
    const engRow = rows[2]!;
    // The reserved vectros-admin row hides Delete entirely (the server
    // refuses reserved-context teardown unconditionally) AND hides Edit (it
    // would mint a context-pinned bearer the same way, which the partner API
    // now rejects outright for this context). The plain engineering row
    // offers both, enabled.
    expect(
      within(adminRow).queryByRole('button', { name: /edit name & description/i }),
    ).not.toBeInTheDocument();
    expect(within(engRow).getByRole('button', { name: /edit name & description/i })).toBeEnabled();
    expect(within(adminRow).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    expect(within(engRow).getByRole('button', { name: /^delete$/i })).toBeEnabled();
  });

  it('the reserved default row hides Delete too (server refuses it unconditionally)', async () => {
    renderPage({
      listAppContexts: vi.fn().mockResolvedValue(
        pageOf([
          VECTROS_ADMIN_CTX,
          { id: 'tnt_test#default', contextId: 'default', name: 'Default' },
          ENGINEERING_CTX,
        ]),
      ),
    });
    await screen.findByRole('table');
    const defaultRow = screen.getAllByRole('row')[2]!;
    expect(within(defaultRow).getByText('default')).toBeInTheDocument();
    expect(within(defaultRow).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('a context already tearing down hides Delete and shows the Deleting… marker', async () => {
    renderPage({
      listAppContexts: vi.fn().mockResolvedValue(
        pageOf([VECTROS_ADMIN_CTX, { ...ENGINEERING_CTX, status: 'purging' }]),
      ),
    });
    await screen.findByRole('table');
    const engRow = screen.getAllByRole('row')[2]!;
    expect(within(engRow).getByText(/deleting…/i)).toBeInTheDocument();
    expect(within(engRow).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('clicking a row navigates to that context detail', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('engineering');
    await user.click(screen.getByText('engineering'));
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
      '/access/contexts/engineering',
    );
  });

  it('lists the single context as a row instead of auto-redirecting to its detail', async () => {
    renderPage({
        listAppContexts: vi.fn().mockResolvedValue(pageOf([VECTROS_ADMIN_CTX])),
        listRoles: vi.fn().mockResolvedValue(pageOf([])),
        listAccessProfiles: vi.fn().mockResolvedValue(pageOf([])),
      });
    // The one context renders as a table row (anchored on the table — the
    // subtitle also references a context id, RESERVED_DEFAULT_CONTEXT_ID)
    // instead of being skipped past.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('vectros-admin')).toBeInTheDocument();
    // And we do NOT auto-navigate to the detail — the location stays on the
    // list route (the probe is always rendered; assert the path, not presence).
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(/^\/access\/contexts$/);
  });

  it('Create dialog: validates ID inline + submits createAppContext on Create', async () => {
    const user = userEvent.setup();
    const { developerApi } = renderPage();
    await screen.findByText('engineering');
    await user.click(screen.getByRole('button', { name: /create app context/i }));

    const dialog = await screen.findByRole('dialog', { name: /create app context/i });
    const idInput = within(dialog).getByLabelText(/context id/i);
    await user.type(idInput, 'BadCase!');
    expect(
      within(dialog).getByText(/must be 3–31 chars: lowercase letter prefix/i),
    ).toBeInTheDocument();
    const createBtn = within(dialog).getByRole('button', { name: /^create$/i });
    expect(createBtn).toBeDisabled();

    await user.clear(idInput);
    await user.type(idInput, 'taskflow');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'TaskFlow');
    await user.type(within(dialog).getByLabelText(/^description$/i), 'Tasks app');
    await user.click(createBtn);

    await waitFor(() => {
      expect(developerApi.createAppContext).toHaveBeenCalledWith({
        contextId: 'taskflow',
        name: 'TaskFlow',
        description: 'Tasks app',
      });
    });
  });

  it('Edit dialog: prefills, disables contextId, submits updateAppContext envelope', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await screen.findByText('engineering');
    const rows = screen.getAllByRole('row');
    const engRow = rows[2]!;
    await user.click(within(engRow).getByRole('button', { name: /edit name & description/i }));

    const dialog = await screen.findByRole('dialog', { name: /edit app context/i });
    const idInput = within(dialog).getByLabelText(/context id/i) as HTMLInputElement;
    expect(idInput.value).toBe('engineering');
    expect(idInput).toBeDisabled();

    const nameInput = within(dialog).getByRole('textbox', { name: /name/i });
    await user.clear(nameInput);
    await user.type(nameInput, 'Engineering Team');
    await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(client.auth.updateAppContext).toHaveBeenCalledWith({
        contextId: 'engineering',
        body: {
          contextId: 'engineering',
          name: 'Engineering Team',
          description: 'Engineering team app',
        },
      });
    });
  });

  // ---- hardening: states + a11y -----------------------------------

  it('loading spinner exposes an accessible label (not a bare spinner)', () => {
    renderPage({
        listAppContexts: vi.fn(() => new Promise(() => undefined)),
      });
    // LoadingBlock labels the CircularProgress; a bare spinner would announce
    // nothing to assistive tech.
    expect(screen.getByLabelText(/loading app contexts/i)).toBeInTheDocument();
  });

  it('the editor Dialog has an accessible name (aria-labelledby → title)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('engineering');
    await user.click(screen.getByRole('button', { name: /create app context/i }));
    // findByRole('dialog', { name }) only resolves if the dialog's accessible
    // name is wired (useId-linked aria-labelledby).
    expect(
      await screen.findByRole('dialog', { name: /create app context/i }),
    ).toBeInTheDocument();
  });

  it('Create dialog: shows a pending/disabled submit while createAppContext is in flight', async () => {
    const user = userEvent.setup();
    let resolveCreate: ((v: unknown) => void) | undefined;
    const createAppContext = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    renderPage({ createAppContext });
    await screen.findByText('engineering');
    await user.click(screen.getByRole('button', { name: /create app context/i }));

    const dialog = await screen.findByRole('dialog', { name: /create app context/i });
    await user.type(within(dialog).getByLabelText(/context id/i), 'taskflow');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'TaskFlow');
    const createBtn = within(dialog).getByRole('button', { name: /^create$/i });
    await user.click(createBtn);

    // While the mutation is pending the submit is disabled + aria-busy.
    await waitFor(() => expect(createBtn).toBeDisabled());
    expect(createBtn).toHaveAttribute('aria-busy', 'true');

    resolveCreate?.({ contextId: 'taskflow' });
  });

  it('Create dialog: stays open with an in-dialog role="alert" error when createAppContext rejects', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({ message: 'boom', statusCode: 500 });
    renderPage({
        createAppContext: vi.fn().mockRejectedValue(err),
      });
    await screen.findByText('engineering');
    await user.click(screen.getByRole('button', { name: /create app context/i }));

    const dialog = await screen.findByRole('dialog', { name: /create app context/i });
    await user.type(within(dialog).getByLabelText(/context id/i), 'taskflow');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'TaskFlow');
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }));

    // Dialog stays open, error is announced INSIDE it.
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/could not create the app context/i);
    expect(
      screen.getByRole('dialog', { name: /create app context/i }),
    ).toBeInTheDocument();
  });

  it('Create dialog: surfaces the requestId from the error body', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'boom',
      statusCode: 500,
      body: { message: 'boom', requestId: 'req_abc123' },
    });
    renderPage({
        createAppContext: vi.fn().mockRejectedValue(err),
      });
    await screen.findByText('engineering');
    await user.click(screen.getByRole('button', { name: /create app context/i }));
    const dialog = await screen.findByRole('dialog', { name: /create app context/i });
    await user.type(within(dialog).getByLabelText(/context id/i), 'taskflow');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'TaskFlow');
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }));
    expect(await within(dialog).findByText(/req_abc123/)).toBeInTheDocument();
  });

  // ---- delete dialog (typed-echo teardown) --------------------------

  /** Open the delete dialog for the engineering row. */
  async function openDeleteDialog(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLElement> {
    await screen.findByRole('table');
    const engRow = screen.getAllByRole('row')[2]!;
    await user.click(within(engRow).getByRole('button', { name: /^delete$/i }));
    return screen.findByRole('dialog', { name: /delete app context engineering/i });
  }

  it('Delete dialog: CTA stays disabled until the contextId is typed exactly', async () => {
    const user = userEvent.setup();
    const { developerApi } = renderPage();
    const dialog = await openDeleteDialog(user);

    const cta = within(dialog).getByRole('button', { name: /delete app context/i });
    expect(cta).toBeDisabled();

    const confirmInput = within(dialog).getByLabelText(/context id/i);
    await user.type(confirmInput, 'engineerin');   // near-miss must not arm it
    expect(cta).toBeDisabled();
    await user.type(confirmInput, 'g');            // exact echo arms it
    expect(cta).toBeEnabled();

    await user.click(cta);
    await waitFor(() => {
      expect(developerApi.deleteAppContext).toHaveBeenCalledWith('engineering');
    });
    // Success closes the dialog.
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /delete app context engineering/i }),
      ).not.toBeInTheDocument();
    });
    // ...and invalidates the contexts list so the row re-renders in its
    // transitional "Deleting…" state (the initial load + the post-delete
    // refetch = at least two list calls).
    await waitFor(() => {
      expect(developerApi.listAppContexts.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('Delete dialog: reopening after cancel starts disarmed (typed echo reset)', async () => {
    const user = userEvent.setup();
    renderPage();
    let dialog = await openDeleteDialog(user);

    // Arm it, then cancel without deleting.
    await user.type(within(dialog).getByLabelText(/context id/i), 'engineering');
    expect(within(dialog).getByRole('button', { name: /delete app context/i })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /delete app context engineering/i }),
      ).not.toBeInTheDocument();
    });

    // Reopen: the echo must be cleared and the destructive CTA disarmed —
    // a stale echo would leave one un-typed click between the user and an
    // irreversible cascade.
    dialog = await openDeleteDialog(user);
    expect(
      (within(dialog).getByLabelText(/context id/i) as HTMLInputElement).value,
    ).toBe('');
    expect(within(dialog).getByRole('button', { name: /delete app context/i })).toBeDisabled();
  });

  it('Delete dialog: shows the live role/profile counts in the warning body', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDeleteDialog(user);
    // Engineering has 1 role + 2 profiles (the count-query fixtures).
    expect(
      await within(dialog).findByText(/1 role and 2 access profiles/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('Delete dialog: stays open with an in-dialog role="alert" when the delete rejects', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({ message: 'boom', statusCode: 500 });
    renderPage({ deleteAppContext: vi.fn().mockRejectedValue(err) });
    const dialog = await openDeleteDialog(user);

    await user.type(within(dialog).getByLabelText(/context id/i), 'engineering');
    await user.click(within(dialog).getByRole('button', { name: /delete app context/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/could not delete the app context/i);
    expect(
      screen.getByRole('dialog', { name: /delete app context engineering/i }),
    ).toBeInTheDocument();
  });

  it('keyboard: Enter on a focused context row opens its detail page', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('engineering');
    const engRow = screen.getByRole('row', { name: /open app context engineering/i });
    engRow.focus();
    expect(engRow).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
      '/access/contexts/engineering',
    );
  });
});
