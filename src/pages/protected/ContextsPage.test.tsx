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
//   8. Every row shows Edit (enabled) + a DISABLED Delete (context teardown is
//      a root-authority op the browser can't perform — surfaced as "coming",
//      not a 403 dead-end).
//   9. Create dialog opens, validates ID format inline, calls the developer
//      API's createAppContext, closes on success, invalidates the list.
//  10. Edit dialog opens with prefilled fields, contextId disabled,
//      calls updateAppContext with the SDK's `{contextId, body}` envelope.
//  11. Row click routes to /access/contexts/:id (excluding action cell
//      clicks, which are stopped).
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

/** Developer-API hook mock: tenant-wide list + owner-gated create. */
function makeMockDeveloperApi(o: MockOverrides = {}) {
  return {
    listAppContexts:
      o.listAppContexts ??
      vi.fn().mockResolvedValue(pageOf([VECTROS_ADMIN_CTX, ENGINEERING_CTX])),
    createAppContext: o.createAppContext ?? vi.fn().mockResolvedValue({ contextId: 'new-ctx' }),
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
    // Wait for the actual table — `vectros-admin` text also appears in the
    // subtitle copy, so we anchor on the table to avoid the false positive.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('vectros-admin')).toBeInTheDocument();
    expect(within(table).getByText('engineering')).toBeInTheDocument();
    expect(within(table).getByText('Vectros Admin')).toBeInTheDocument();
    expect(within(table).getByText('Engineering')).toBeInTheDocument();
  });

  it('shows per-row role + profile counts when the parallel queries resolve', async () => {
    renderPage();
    await screen.findByText('engineering');
    // Engineering: 1 role + 2 profiles. vectros-admin: 0/0.
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    expect(screen.getByText('2')).toBeInTheDocument();
    // Two zero-count cells (vectros-admin's roles + profiles).
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2);
  });

  it('shows a disabled Delete action on every row (teardown not available here yet)', async () => {
    renderPage();
    // Wait for the table to actually render (not the subtitle's vectros-admin).
    await screen.findByRole('table');
    const rows = screen.getAllByRole('row');
    // rows[0] is the header.
    const adminRow = rows[1]!;
    const engRow = rows[2]!;
    // Every row shows Edit (enabled) + Delete (disabled — context teardown is a
    // root-authority op the browser can't perform, surfaced as a "coming" state
    // rather than a 403 dead-end or a hidden control).
    for (const row of [adminRow, engRow]) {
      expect(within(row).getByRole('button', { name: /edit name & description/i })).toBeEnabled();
      expect(within(row).getByRole('button', { name: /^delete$/i })).toBeDisabled();
    }
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
    // The one context renders as a table row (anchored on the table — the id
    // also appears in the subtitle copy) instead of being skipped past.
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
