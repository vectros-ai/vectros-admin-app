// ---------------------------------------------------------------------------
// RoleEditor tests.
//
// Pinning:
//   1. Create mode (route ends /new): blank form, Save disabled until
//      valid + dirty. Submit calls createRole envelope
//      and navigates to /roles/:newId.
//   2. Edit mode: fetches the role, prefills form, propagation
//      banner surfaces when refs > 0, banner links to ?roleId=
//      filter on the Profiles tab.
//   3. Dirty-state guard fires on Cancel: `useBeforeNavigate(dirty)`
//      prompts window.confirm; user can stay or proceed. Tested in
//      useBeforeNavigate.test.tsx (the hook itself); here we just
//      confirm the editor wires `dirty` correctly.
//   4. Clone Dialog: prefills "{id}-copy" / "{name} (copy)", submits
//      with cloned scopes verbatim, navigates to the new edit page.
//   5. Delete Dialog: disabled while profiles loading; disabled when
//      refs > 0; enabled when zero refs; on submit calls
//      deleteRole envelope and navigates back to the
//      Roles tab.
//   6. SDK envelope shapes pinned: createRole(
//      {contextId, body}), updateRole({contextId,
//      roleId, body}), deleteRole({contextId,
//      roleId}).
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { RoleEditor } from './RoleEditor';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

// ---- fixtures ------------------------------------------------------------

const ROLE_ENG_MEMBER = {
  contextId: 'engineering',
  roleId: 'eng-member',
  name: 'Engineering Team Member',
  description: 'Standard read-only access for engineering members',
  scopes: [
    {
      allowed_actions: ['records:r', 'documents:r'],
      data_scope: {},
    },
  ],
  createdAt: '2026-05-15T09:00:00Z',
  lastModified: '2026-05-20T11:00:00Z',
};

// Profiles list — Alice references eng-member, bot is inline (doesn't ref).
const PROFILES = [
  {
    contextId: 'engineering',
    principalId: 'usr_alice',
    roleId: 'eng-member',
  },
  {
    contextId: 'engineering',
    principalId: 'key_research-bot',
    scopes: [{ allowed_actions: ['rag:c'] }],
  },
];

interface MockOverrides {
  getRole?: ReturnType<typeof vi.fn>;
  createRole?: ReturnType<typeof vi.fn>;
  updateRole?: ReturnType<typeof vi.fn>;
  deleteRole?: ReturnType<typeof vi.fn>;
  listAccessProfiles?: ReturnType<typeof vi.fn>;
  listRoles?: ReturnType<typeof vi.fn>;
  listNamespaces?: ReturnType<typeof vi.fn>;
}

function makeMockClient(o: MockOverrides = {}) {
  return {
    // The namespace registry (lib/namespaceRegistry.ts) — no test here
    // exercises namespace SUGGESTIONS specifically (see ScopeEditor's own
    // tests for that); defaulted so every existing test gets a resolved
    // query rather than a silently-swallowed rejection.
    identity: {
      listNamespaces: o.listNamespaces ?? vi.fn().mockResolvedValue(pageOf([])),
    },
    auth: {
      getRole:
        o.getRole ?? vi.fn().mockResolvedValue(ROLE_ENG_MEMBER),
      createRole:
        o.createRole ??
        vi.fn().mockImplementation(({ body }: { body: { roleId: string } }) =>
          Promise.resolve({ ...ROLE_ENG_MEMBER, roleId: body.roleId }),
        ),
      updateRole:
        o.updateRole ?? vi.fn().mockResolvedValue(ROLE_ENG_MEMBER),
      deleteRole:
        o.deleteRole ?? vi.fn().mockResolvedValue(undefined),
      listAccessProfiles:
        o.listAccessProfiles ?? vi.fn().mockResolvedValue(pageOf(PROFILES)),
      // Sources the ScopeEditor's `assignable_roles` picker suggestions —
      // same context-roles query ProfileEditor's role-composition
      // Autocomplete uses. Defaulted (not left unstubbed) so every existing
      // test here gets a resolved query rather than a silently-swallowed
      // rejection; tests that care about the actual suggestions override it.
      listRoles:
        o.listRoles ?? vi.fn().mockResolvedValue(pageOf([ROLE_ENG_MEMBER])),
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="probe-pathname">{location.pathname + location.search}</div>
  );
}

function renderEditor(
  opts: { client?: ReturnType<typeof makeMockClient>; initialUrl: string } = {
    initialUrl: '/access/contexts/engineering/roles/new',
  },
) {
  const client = opts.client ?? makeMockClient();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Legacy <MemoryRouter> — matches production's <BrowserRouter>. Using
  // createMemoryRouter (data router) would silently allow `useBlocker`
  // calls that production rejects at runtime — see useBeforeNavigate.ts
  // file header for the lesson.
  const utils = render(
    <TestIntlProvider>
      <QueryClientProvider client={queryClient}>
        <TestTenantProvider>
          <MemoryRouter initialEntries={[opts.initialUrl]}>
            <Routes>
              <Route
                path="/access/contexts/:ctxId/roles/:tplId"
                element={
                  <>
                    <RoleEditor />
                    <LocationProbe />
                  </>
                }
              />
              <Route path="/access/contexts/:ctxId" element={<LocationProbe />} />
              <Route path="/access/contexts" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </TestTenantProvider>
      </QueryClientProvider>
    </TestIntlProvider>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  // Some tests need to silence the navigation-guard prompt; the editor's
  // dirty-state useBeforeNavigate calls window.confirm on route change.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('RoleEditor — create mode', () => {
  it('renders blank form; Save disabled until valid + dirty', async () => {
    const user = userEvent.setup();
    renderEditor();
    expect(
      await screen.findByRole('heading', { level: 1, name: /create role/i }),
    ).toBeInTheDocument();

    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();

    // Fill the ID — Save still disabled (name + scope required).
    const idInput = screen.getByRole('textbox', { name: /role id/i });
    await user.type(idInput, 'analyst');
    expect(saveBtn).toBeDisabled();

    // Fill the name + grant a permission on the (already-present) blank clause.
    const nameInput = screen.getByRole('textbox', { name: /name/i });
    await user.type(nameInput, 'Analyst');
    // Grant Read on Records via the ScopeEditor permission matrix.
    await user.click(screen.getByRole('checkbox', { name: /read records/i }));
    await waitFor(() => expect(saveBtn).toBeEnabled());
  });

  it('Save calls createRole envelope and navigates to /:newId', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create role/i });

    // Minimal valid form: ID + name + one action.
    await user.type(screen.getByRole('textbox', { name: /role id/i }), 'analyst');
    await user.type(screen.getByRole('textbox', { name: /name/i }), 'Analyst');
    await user.click(screen.getByRole('checkbox', { name: /read records/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(client.auth.createRole).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createRole.mock.calls[0]?.[0] as {
      contextId: string;
      body: {
        roleId: string;
        name: string;
        scopes: ReadonlyArray<{ allowed_actions: string[]; data_scope: unknown }>;
      };
    };
    expect(call.contextId).toBe('engineering');
    expect(call.body.roleId).toBe('analyst');
    expect(call.body.name).toBe('Analyst');
    expect(call.body.scopes[0]?.allowed_actions).toEqual(['records:r']);

    // After create, the editor navigates to the new role's edit page.
    await waitFor(() =>
      expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
        '/access/contexts/engineering/roles/analyst',
      ),
    );
  });
});

describe('RoleEditor — edit mode', () => {
  it('prefills the form from getRole', async () => {
    renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i }),
    ).toBeInTheDocument();
    const nameInput = (await screen.findByRole('textbox', {
      name: /name/i,
    })) as HTMLInputElement;
    expect(nameInput.value).toBe('Engineering Team Member');
    const descInput = screen.getByRole('textbox', { name: /description/i }) as HTMLInputElement;
    expect(descInput.value).toBe('Standard read-only access for engineering members');
  });

  it('never flags a typed data-scope namespace as unregistered while the namespace registry is still loading', async () => {
    // The S2 regression this guards: ScopeEditor's data-scope namespace
    // field must not read "not registered" just because the registry
    // hasn't answered yet (a never-resolving listNamespaces here).
    const user = userEvent.setup();
    const client = makeMockClient({ listNamespaces: vi.fn(() => new Promise(() => undefined)) });
    renderEditor({ client, initialUrl: '/access/contexts/engineering/roles/eng-member' });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });

    await user.click(await screen.findByRole('button', { name: /row-level data filters/i }));
    await user.click(screen.getByRole('button', { name: /add filter/i }));
    await user.type(screen.getByRole('combobox', { name: /scope/i }), 'org');

    expect(screen.queryByText(/not registered for this context/i)).not.toBeInTheDocument();
  });

  it('blocks saving and says why when the profile drain fails', async () => {
    // The propagation banner is gated on a COUNT, and a failed drain counts
    // zero — indistinguishable from "no profile uses this role". Without a
    // guard the editor presents an unreferenced-looking role and lets it be
    // saved, propagating the edit to every profile that actually references it.
    const client = makeMockClient({
      listAccessProfiles: vi.fn().mockRejectedValue(new Error('400 invalid_cursor')),
    });
    renderEditor({ client, initialUrl: '/access/contexts/engineering/roles/eng-member' });

    expect(
      await screen.findByText(/cannot tell you which ones use this role/i),
    ).toBeInTheDocument();
    // The propagation banner must NOT claim zero referencing profiles.
    expect(screen.queryByText(/changes propagate to/i)).not.toBeInTheDocument();
    // And Save stays disabled even after a real edit makes the form dirty.
    const nameInput = await screen.findByRole('textbox', { name: /name/i });
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed Role');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled(),
    );
  });

  it('renders the propagation banner with refs count', async () => {
    renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    // Alice references eng-member → 1 profile.
    expect(
      await screen.findByText(/changes propagate to 1 referencing profile/i),
    ).toBeInTheDocument();
    // Banner has a "View referencing profiles" CTA.
    expect(
      screen.getByRole('button', { name: /view referencing profiles/i }),
    ).toBeInTheDocument();
  });

  it('view-referencing-profiles link routes to the Profiles tab with ?roleId=', async () => {
    const user = userEvent.setup();
    renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByText(/changes propagate to 1 referencing profile/i);
    await user.click(screen.getByRole('button', { name: /view referencing profiles/i }));
    expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
      '/access/contexts/engineering?tab=profiles&roleId=eng-member',
    );
  });

  it('Save calls updateRole envelope', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    const nameInput = (await screen.findByRole('textbox', {
      name: /name/i,
    })) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Engineering Member v2');

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(client.auth.updateRole).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.updateRole.mock.calls[0]?.[0] as {
      contextId: string;
      roleId: string;
      body: { name: string };
    };
    expect(call.contextId).toBe('engineering');
    expect(call.roleId).toBe('eng-member');
    expect(call.body.name).toBe('Engineering Member v2');
  });
});

describe('RoleEditor — dirty-state regression', () => {
  it('clean on load: Save stays disabled on a pristine edit form', async () => {
    renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    // The heading renders immediately from the URL param; wait for the form
    // to finish loading (name seeded from the role) so we assert against the
    // LOADED form, not the loading skeleton.
    expect(
      (await screen.findByRole('textbox', { name: /name/i })) as HTMLInputElement,
    ).toHaveValue('Engineering Team Member');
    // Before the fix the dirty check stringify-compared the full scope clause
    // ({allowed_actions, data_scope}) against a baseline projected to
    // {allowed_actions} only, so it never matched → permanently dirty →
    // Save enabled on a freshly loaded, untouched form. It must be disabled.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('becomes dirty when a scope action is edited', async () => {
    const user = userEvent.setup();
    renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    // Wait for the form to load, then confirm it starts clean.
    await screen.findByRole('textbox', { name: /name/i });
    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();
    // Edit the scope matrix — grant an op the loaded role lacks (it starts with
    // records:r / documents:r; adding Create on Records makes the form dirty).
    await user.click(await screen.findByRole('checkbox', { name: /create records/i }));
    await waitFor(() => expect(saveBtn).toBeEnabled());
  });
});

describe('RoleEditor — clone dialog', () => {
  it('prefills "{id}-copy" / "{name} (copy)" and routes to the clone\'s edit page', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    // Clone is disabled until the role baseline loads — wait for enabled.
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);

    const dialog = await screen.findByRole('dialog', { name: /clone role/i });
    const idInput = within(dialog).getByRole('textbox', { name: /new role id/i }) as HTMLInputElement;
    expect(idInput.value).toBe('eng-member-copy');
    const nameInput = within(dialog).getByRole('textbox', { name: /new name/i }) as HTMLInputElement;
    expect(nameInput.value).toBe('Engineering Team Member (copy)');

    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));
    await waitFor(() => {
      expect(client.auth.createRole).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createRole.mock.calls[0]?.[0] as {
      contextId: string;
      body: { roleId: string; scopes: unknown[] };
    };
    expect(call.contextId).toBe('engineering');
    expect(call.body.roleId).toBe('eng-member-copy');
    // Scopes carried over verbatim — the source had one clause with two actions.
    expect(call.body.scopes).toHaveLength(1);
  });

  it('carries assumable through a clone — it is NOT a clause field, so the clause-level sweep cannot see it', async () => {
    // The /assume entitlement grant sits on the ROLE, one level above the
    // clause list, which is why three passes over "carry every clause field"
    // kept missing it. Create sets it unconditionally from the request, so a
    // clone that omits it is silently a lesser role than the one it copied.
    const user = userEvent.setup();
    const ROLE_ASSUMABLE = {
      ...ROLE_ENG_MEMBER,
      assumable: { 'scope:org': ['org_eng'] },
    };
    const { client } = renderEditor({
      client: makeMockClient({ getRole: vi.fn().mockResolvedValue(ROLE_ASSUMABLE) }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);
    const dialog = await screen.findByRole('dialog', { name: /clone role/i });
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));

    await waitFor(() => expect(client.auth.createRole).toHaveBeenCalledTimes(1));
    const call = client.auth.createRole.mock.calls[0]?.[0] as {
      body: { assumable?: Record<string, unknown> };
    };
    expect(call.body.assumable).toEqual({ 'scope:org': ['org_eng'] });
  });

  it('omits assumable entirely when the source role has none — the safe default is absence, not an empty map', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);
    const dialog = await screen.findByRole('dialog', { name: /clone role/i });
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));

    await waitFor(() => expect(client.auth.createRole).toHaveBeenCalledTimes(1));
    const call = client.auth.createRole.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(call.body).not.toHaveProperty('assumable');
  });

  it('preserves a row-scoped clause\'s data_scope on clone (no silent broadening)', async () => {
    const user = userEvent.setup();
    const ROLE_SCOPED = {
      ...ROLE_ENG_MEMBER,
      scopes: [{ allowed_actions: ['records:r'], data_scope: { 'scope:org': ['org_eng'] } }],
    };
    const { client } = renderEditor({
      client: makeMockClient({ getRole: vi.fn().mockResolvedValue(ROLE_SCOPED) }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    // Clone is disabled until the role baseline loads — wait for enabled.
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);
    const dialog = await screen.findByRole('dialog', { name: /clone role/i });
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));
    await waitFor(() => expect(client.auth.createRole).toHaveBeenCalledTimes(1));
    const call = client.auth.createRole.mock.calls[0]?.[0] as {
      body: { scopes: Array<{ allowed_actions: string[]; data_scope: unknown }> };
    };
    // The clause's row filter must survive — dropping it would widen to all rows.
    expect(call.body.scopes[0]?.data_scope).toEqual({ 'scope:org': ['org_eng'] });
  });
});

describe('RoleEditor — delete dialog', () => {
  it('Delete is disabled when refs > 0', async () => {
    const user = userEvent.setup();
    renderEditor({
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    // Wait for the profiles fetch to complete (referencing count = 1).
    await screen.findByText(/changes propagate to 1 referencing profile/i);

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete role/i });
    expect(within(dialog).getByText(/1 profile reference/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /delete role/i })).toBeDisabled();
  });

  it('Delete is disabled when the only reference is via multi-role composition (roleIds, not roleId)', async () => {
    const user = userEvent.setup();
    // eng-member is referenced ONLY via a roleIds composition — roleId is
    // absent on this profile shape (0.41.0). A referencingCount that keys
    // on roleId alone would read 0 here and wrongly enable Delete.
    renderEditor({
      client: makeMockClient({
        listAccessProfiles: vi.fn().mockResolvedValue(
          pageOf([
            {
              contextId: 'engineering',
              principalId: 'usr_charlie',
              roleIds: ['hr-admin', 'eng-member'],
            },
          ]),
        ),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    await screen.findByText(/changes propagate to 1 referencing profile/i);

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete role/i });
    expect(within(dialog).getByText(/1 profile reference/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /delete role/i })).toBeDisabled();
  });

  it('Delete enabled when zero refs; submits envelope and navigates to Roles tab', async () => {
    const user = userEvent.setup();
    // Profiles list with NO refs to eng-member (bot is inline).
    const { client } = renderEditor({
      client: makeMockClient({
        listAccessProfiles: vi.fn().mockResolvedValue(
          pageOf([
            {
              contextId: 'engineering',
              principalId: 'key_bot',
              scopes: [{ allowed_actions: ['*'] }],
            },
          ]),
        ),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    // Wait for profiles fetch to settle (no banner since refs = 0).
    await waitFor(() => {
      expect(client.auth.listAccessProfiles).toHaveBeenCalled();
    });

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete role/i });
    const deleteBtn = within(dialog).getByRole('button', { name: /delete role/i });
    await waitFor(() => expect(deleteBtn).toBeEnabled());
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(client.auth.deleteRole).toHaveBeenCalledWith({
        contextId: 'engineering',
        roleId: 'eng-member',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
        '/access/contexts/engineering?tab=roles',
      );
    });
  });

  it('keeps the dialog OPEN + announces an error (role=alert + requestId) on delete failure', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'nope',
      statusCode: 500,
      body: { message: 'nope', requestId: 'req-rdel-5' },
    });
    const { client } = renderEditor({
      client: makeMockClient({
        deleteRole: vi.fn().mockRejectedValue(err),
        listAccessProfiles: vi.fn().mockResolvedValue(
          pageOf([
            { contextId: 'engineering', principalId: 'key_bot', scopes: [{ allowed_actions: ['*'] }] },
          ]),
        ),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    await waitFor(() => expect(client.auth.listAccessProfiles).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete role/i });
    const deleteBtn = within(dialog).getByRole('button', { name: /delete role/i });
    await waitFor(() => expect(deleteBtn).toBeEnabled());
    await user.click(deleteBtn);

    // Error announced inside the still-open dialog, carrying the requestId.
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeInTheDocument());
    expect(within(dialog).getByText(/req-rdel-5/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /delete role/i })).toBeInTheDocument();
  });
});

// ---- helpers for the hardening suite -------------------------------------

async function fillValidCreateForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByRole('textbox', { name: /role id/i }), 'analyst');
  await user.type(screen.getByRole('textbox', { name: /name/i }), 'Analyst');
  await user.click(screen.getByRole('checkbox', { name: /read records/i }));
}

describe('RoleEditor — hardening states', () => {
  it('shows a labeled loading spinner while the role is fetching', async () => {
    let resolve: ((v: unknown) => void) | undefined;
    renderEditor({
      client: makeMockClient({
        getRole: vi.fn().mockReturnValue(
          new Promise((r) => {
            resolve = r;
          }),
        ),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    expect(await screen.findByLabelText(/loading roles/i)).toBeInTheDocument();
    resolve?.(ROLE_ENG_MEMBER);
  });

  it('surfaces an ApiErrorAlert (role=alert + requestId) when the role load fails', async () => {
    const err = new VectrosError({
      message: 'Boom',
      statusCode: 503,
      body: { message: 'Boom', requestId: 'req-rload-3' },
    });
    renderEditor({
      client: makeMockClient({ getRole: vi.fn().mockRejectedValue(err) }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load this role/i);
    expect(alert).toHaveTextContent(/req-rload-3/);
  });

  it('Save shows a pending/disabled SubmitButton while the create is in flight', async () => {
    const user = userEvent.setup();
    let resolve: ((v: unknown) => void) | undefined;
    renderEditor({
      client: makeMockClient({
        createRole: vi.fn().mockReturnValue(
          new Promise((r) => {
            resolve = r;
          }),
        ),
      }),
      initialUrl: '/access/contexts/engineering/roles/new',
    });
    await screen.findByRole('heading', { level: 1, name: /create role/i });
    await fillValidCreateForm(user);
    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await user.click(saveBtn);

    await waitFor(() => expect(saveBtn).toBeDisabled());
    expect(saveBtn).toHaveAttribute('aria-busy', 'true');
    resolve?.({ ...ROLE_ENG_MEMBER, roleId: 'analyst' });
  });

  it('surfaces a specific duplicate-id message on a 409 when creating a role', async () => {
    const user = userEvent.setup();
    const conflict = new VectrosError({
      message: 'already exists',
      statusCode: 409,
      body: { message: 'already exists', requestId: 'req-rdup-1' },
    });
    renderEditor({
      client: makeMockClient({
        createRole: vi.fn().mockRejectedValue(conflict),
      }),
      initialUrl: '/access/contexts/engineering/roles/new',
    });
    await screen.findByRole('heading', { level: 1, name: /create role/i });
    await fillValidCreateForm(user);
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Specific duplicate-id copy is shown (announced via the ApiErrorAlert's
    // role="alert"); the generic save-error copy is NOT.
    const dupMsg = await screen.findByText(/role with this id already exists/i);
    expect(dupMsg.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText(/could not save this role/i)).not.toBeInTheDocument();
  });

  it('surfaces the server-specific reason beneath the generic title on a non-conflict save failure (0.40.0)', async () => {
    const user = userEvent.setup();
    const denial = new VectrosError({
      message: 'forbidden',
      statusCode: 403,
      body: { message: 'The namespace "billing" is not one this credential may write.', requestId: 'req-403-1' },
    });
    renderEditor({
      client: makeMockClient({
        createRole: vi.fn().mockRejectedValue(denial),
      }),
      initialUrl: '/access/contexts/engineering/roles/new',
    });
    await screen.findByRole('heading', { level: 1, name: /create role/i });
    await fillValidCreateForm(user);
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // ScopeEditor's own info Alert also carries role="alert" — scope to the
    // element actually carrying the save-error copy, same as the
    // duplicate-id test above.
    const errorMsg = await screen.findByText(/could not save this role/i);
    const alert = errorMsg.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent(/not one this credential may write/i);
    expect(alert).toHaveTextContent(/req-403-1/);
  });

  it('shows only the generic save-error title (no stray detail line) when the error carries no body message', async () => {
    const user = userEvent.setup();
    const bare = new VectrosError({ message: 'boom', statusCode: 500 });
    renderEditor({
      client: makeMockClient({
        createRole: vi.fn().mockRejectedValue(bare),
      }),
      initialUrl: '/access/contexts/engineering/roles/new',
    });
    await screen.findByRole('heading', { level: 1, name: /create role/i });
    await fillValidCreateForm(user);
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const errorMsg = await screen.findByText(/could not save this role/i);
    expect(errorMsg.closest('[role="alert"]')).not.toBeNull();
  });

  it('a save carries granted_capabilities through untouched (0.40.0 round-trip safety)', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getRole: vi.fn().mockResolvedValue({
          contextId: 'engineering',
          roleId: 'eng-member',
          name: 'Engineering Team Member',
          scopes: [
            {
              allowed_actions: ['records:r', 'documents:r'],
              data_scope: {},
              granted_capabilities: ['context-directory-read'],
            },
          ],
        }),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    // Edit something ELSE (the name field) — never touch the capabilities
    // checkboxes — to make the form dirty and enable Save. The form body
    // (behind `baseline`) mounts asynchronously after the role load resolves.
    const nameInput = await screen.findByRole('textbox', { name: /^name$/i });
    await user.type(nameInput, ' (updated)');
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateRole).toHaveBeenCalledTimes(1));
    const call = client.auth.updateRole.mock.calls[0]?.[0] as {
      body: { scopes?: Array<{ granted_capabilities?: string[] }> };
    };
    expect(call.body.scopes?.[0]?.granted_capabilities).toEqual(['context-directory-read']);
  });

  it('a save carries assignable_roles through untouched — dropping it silently WIDENS the grant', async () => {
    // The 0.43.0 twin of the test above, and the regression it guards is the
    // more dangerous direction: `granted_capabilities` going missing narrows a
    // grant, while `assignable_roles` going missing REMOVES a role-composition
    // restriction, handing the delegate back the composing power it exists to
    // close. This asserts against the SAVE BODY, not the extracted helper — the
    // bug lived in this file's own hand-written clause mapping, so a test that
    // stops at the helper would pass on the unfixed code.
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getRole: vi.fn().mockResolvedValue({
          contextId: 'engineering',
          roleId: 'eng-member',
          name: 'Engineering Team Member',
          scopes: [
            {
              allowed_actions: ['profiles:c'],
              data_scope: {},
              assignable_roles: ['support', 'viewer'],
            },
          ],
        }),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    const nameInput = await screen.findByRole('textbox', { name: /^name$/i });
    await user.type(nameInput, ' (updated)');
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateRole).toHaveBeenCalledTimes(1));
    const call = client.auth.updateRole.mock.calls[0]?.[0] as {
      body: { scopes?: Array<{ assignable_roles?: string[] }> };
    };
    expect(call.body.scopes?.[0]?.assignable_roles).toEqual(['support', 'viewer']);
  });

  it('a save of an UNRESTRICTED clause omits assignable_roles entirely — the platform rejects an empty list', async () => {
    // The opposite failure: emitting `[]` for every ordinary clause would turn
    // a routine save into a 400. `[]` is truthy in JS, so this is a real edge.
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getRole: vi.fn().mockResolvedValue({
          contextId: 'engineering',
          roleId: 'eng-member',
          name: 'Engineering Team Member',
          scopes: [{ allowed_actions: ['records:r'], data_scope: {} }],
        }),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    const nameInput = await screen.findByRole('textbox', { name: /^name$/i });
    await user.type(nameInput, ' (updated)');
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateRole).toHaveBeenCalledTimes(1));
    const call = client.auth.updateRole.mock.calls[0]?.[0] as {
      body: { scopes?: Array<Record<string, unknown>> };
    };
    expect(call.body.scopes?.[0]).not.toHaveProperty('assignable_roles');
  });

  it('offers this context\'s own roles as assignable_roles-picker suggestions', async () => {
    // Regression target: dropping the `roleOptions={assignableRoleOptions}`
    // prop from ScopeEditor's JSX (or the rolesQuery feeding it) would
    // silently fall back to a suggestion-less freeSolo field with no other
    // test noticing.
    const user = userEvent.setup();
    renderEditor({
      client: makeMockClient({
        listRoles: vi.fn().mockResolvedValue(pageOf([ROLE_ENG_MEMBER])),
      }),
      initialUrl: '/access/contexts/engineering/roles/new',
    });
    await screen.findByRole('heading', { level: 1, name: /create role/i });
    await user.click(await screen.findByRole('button', { name: /composable roles/i }));
    await user.click(
      screen.getByRole('combobox', { name: /roles this clause may compose/i }),
    );
    expect(
      await screen.findByRole('option', { name: 'Engineering Team Member (eng-member)' }),
    ).toBeInTheDocument();
  });

  it('announces a scope-validation failure via role="alert"', async () => {
    renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create role/i });
    // The default blank clause has no actions → validateClauses returns the
    // `noActions` error, so the inline scope-validation message renders. It
    // MUST carry role="alert" so the failure is announced (the bug this guards).
    const validationMsg = await screen.findByText(/clause 1:.*grant at least one permission/i);
    expect(validationMsg).toHaveAttribute('role', 'alert');
  });

  it('keeps the Clone dialog OPEN + announces a clone error on failure', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'nope',
      statusCode: 500,
      body: { message: 'nope', requestId: 'req-rclone-2' },
    });
    renderEditor({
      client: makeMockClient({
        createRole: vi.fn().mockRejectedValue(err),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    await screen.findByRole('heading', { level: 1, name: /edit role eng-member/i });
    await user.click(screen.getByRole('button', { name: /^clone$/i }));
    const dialog = await screen.findByRole('dialog', { name: /clone role/i });
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeInTheDocument());
    expect(within(dialog).getByText(/req-rclone-2/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /clone role/i })).toBeInTheDocument();
  });

  it('disables Clone + Delete until the role baseline has loaded', async () => {
    let resolve: ((v: unknown) => void) | undefined;
    renderEditor({
      client: makeMockClient({
        getRole: vi.fn().mockReturnValue(
          new Promise((r) => {
            resolve = r;
          }),
        ),
      }),
      initialUrl: '/access/contexts/engineering/roles/eng-member',
    });
    const cloneBtn = await screen.findByRole('button', { name: /^clone$/i });
    expect(cloneBtn).toBeDisabled();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeDisabled();
    resolve?.(ROLE_ENG_MEMBER);
    await waitFor(() => expect(cloneBtn).toBeEnabled());
  });
});
