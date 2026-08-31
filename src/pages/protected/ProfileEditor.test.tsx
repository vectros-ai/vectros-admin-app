// ---------------------------------------------------------------------------
// ProfileEditor tests.
//
// Pinning:
//   1. Create mode: blank form, Save gated on (principalId valid +
//      source valid + dirty).
//   2. Create with role source: Save submits createAccessProfile
//      envelope with `roleId` (NOT scopes).
//   3. Create with inline source: Save submits with `scopes` (NOT
//      roleId). XOR enforced UI-side.
//   4. Source switch confirms before discarding the abandoned side's
//      draft.
//   5. Identity overrides expand/collapse + non-empty values submit
//      under `identityOverrides`; empty values omit the field.
//   6. Edit mode: prefills from getAccessProfile; sourceType derived
//      from whether the loaded profile has roleId.
//   7. Edit mode update: SDK envelope shape {contextId, principalId, body}.
//   8. Clone dialog: prompts new principalId; materialize toggle on
//      → copies role scopes inline; off → preserves roleId.
//   9. Delete dialog: unconditional submit (no ref refusal), envelope
//      {contextId, principalId}, navigates back to ?tab=profiles.
//  10. Identity-override AUTHORING (edit/clone/delete) is a LIVE, per-session
//      check, not a fixed app fact — registerScope(['*']) in beforeEach
//      defaults every test to a no-identity session (fields disabled,
//      Clone/Delete blocked when the target has overrides); tests that need
//      the opposite register an identity explicitly, per-test.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetVectrosApiTokenCacheForTest } from '@vectros-ai/react';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import { registerScope } from '../../test/scopeToken';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { ProfileEditor } from './ProfileEditor';
import { usePrincipalDirectory, userPrincipalId } from '../../lib/usePrincipalDirectory';
import type * as PrincipalDir from '../../lib/usePrincipalDirectory';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

// The principal picker + edit-mode label resolve users via the directory;
// mock it deterministically (keep the real `userPrincipalId` helper).
vi.mock('../../lib/usePrincipalDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof PrincipalDir>();
  return { ...actual, usePrincipalDirectory: vi.fn() };
});

const DIR_USERS = [
  { id: 'alice', email: 'alice@example.com' },
  { id: 'charlie', email: 'charlie@example.com' },
];

// ---- fixtures ------------------------------------------------------------

const ROLE_ENG_MEMBER = {
  contextId: 'engineering',
  roleId: 'eng-member',
  name: 'Engineering Team Member',
  scopes: [
    {
      allowed_actions: ['records:r', 'documents:r'],
      data_scope: {},
    },
  ],
};

const ROLE_ANALYST = {
  contextId: 'engineering',
  roleId: 'analyst',
  name: 'Analyst',
  scopes: [{ allowed_actions: ['records:r'], data_scope: {} }],
};

const ROLE_VIEWER = {
  contextId: 'engineering',
  roleId: 'viewer',
  name: 'Viewer',
  scopes: [{ allowed_actions: ['records:r'], data_scope: {} }],
};

const PROFILE_ALICE_ROLED = {
  contextId: 'engineering',
  principalId: 'usr_alice',
  roleId: 'eng-member',
  identityOverrides: { 'scope:org': 'org_eng' } as Record<string, unknown>,
};

interface MockOverrides {
  getAccessProfile?: ReturnType<typeof vi.fn>;
  createAccessProfile?: ReturnType<typeof vi.fn>;
  updateAccessProfile?: ReturnType<typeof vi.fn>;
  deleteAccessProfile?: ReturnType<typeof vi.fn>;
  listRoles?: ReturnType<typeof vi.fn>;
}

function makeMockClient(o: MockOverrides = {}) {
  return {
    auth: {
      getAccessProfile: o.getAccessProfile ?? vi.fn().mockResolvedValue(PROFILE_ALICE_ROLED),
      createAccessProfile:
        o.createAccessProfile ??
        vi
          .fn()
          .mockImplementation(({ body }: { body: { principalId: string } }) =>
            Promise.resolve({ contextId: 'engineering', ...body }),
          ),
      updateAccessProfile: o.updateAccessProfile ?? vi.fn().mockResolvedValue(PROFILE_ALICE_ROLED),
      deleteAccessProfile: o.deleteAccessProfile ?? vi.fn().mockResolvedValue(undefined),
      listRoles: o.listRoles ?? vi.fn().mockResolvedValue(pageOf([ROLE_ENG_MEMBER, ROLE_ANALYST])),
    },
  };
}

/** Opens the role Autocomplete and clicks a matching option — the shared
 *  "select one role" interaction used across create/edit tests below. */
async function selectRoleOption(user: ReturnType<typeof userEvent.setup>, optionName: RegExp) {
  const input = screen.getByRole('combobox', { name: /^role/i });
  await user.click(input);
  await user.click(await screen.findByRole('option', { name: optionName }));
}

/** Removes the last-selected role chip via Backspace on the empty input —
 *  the multi-select Autocomplete's built-in remove gesture (no per-chip
 *  delete-button accessible name is exposed by MUI's default rendering). */
async function removeLastRoleChip(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole('combobox', { name: /^role/i });
  await user.click(input);
  await user.keyboard('{Backspace}');
  // Close the listbox — clicking the input to focus it also opens the
  // dropdown, and a still-selectable role's label then appears TWICE (as
  // a dropdown option, in addition to any remaining chip), which trips up
  // a plain text query for "is this chip gone".
  await user.keyboard('{Escape}');
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="probe-pathname">{location.pathname + location.search}</div>;
}

function renderEditor(
  opts: { client?: ReturnType<typeof makeMockClient>; initialUrl: string } = {
    initialUrl: '/access/contexts/engineering/profiles/new',
  },
) {
  const client = opts.client ?? makeMockClient();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  vi.mocked(usePrincipalDirectory).mockReturnValue({
    users: DIR_USERS as never,
    isLoading: false,
    isError: false,
    resolve: (pid: string) => {
      const u = DIR_USERS.find((x) => userPrincipalId(x.id) === pid);
      if (u)
        return {
          kind: 'user',
          label: u.email,
          hasName: true,
          principalId: pid,
          user: u as never,
          unresolved: false,
        };
      if (pid.startsWith('key_'))
        return { kind: 'key', label: pid, hasName: false, principalId: pid, unresolved: false };
      if (pid.startsWith('usr_'))
        return { kind: 'user', label: pid, hasName: false, principalId: pid, unresolved: true };
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
          <MemoryRouter initialEntries={[opts.initialUrl]}>
            <Routes>
              <Route
                path="/access/contexts/:ctxId/profiles/:principalId"
                element={
                  <>
                    <ProfileEditor />
                    <LocationProbe />
                  </>
                }
              />
              <Route path="/access/contexts/:ctxId" element={<LocationProbe />} />
              <Route path="/access/contexts/:ctxId/roles/:tplId" element={<LocationProbe />} />
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
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  // Default every test to a wildcard-actions, NO-identity session (an owner
  // shape) — matches the existing tests' assumption that identity-override
  // authoring is disabled unless a test explicitly registers a session that
  // holds one. Mirrors MembersPage.test.tsx's own default-scope convention.
  registerScope(['*']);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  __resetVectrosApiTokenCacheForTest();
});

describe('ProfileEditor — create mode', () => {
  it('Save disabled until valid principalId + source selection', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });

    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();

    // Fill principalId — Save still disabled (role source selected
    // by default; need a role).
    await user.type(screen.getByRole('combobox', { name: /user/i }), 'usr_charlie');
    expect(saveBtn).toBeDisabled();

    // Pick a role via Autocomplete.
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.type(tplInput, 'analyst');
    await user.click(await screen.findByRole('option', { name: /analyst/i }));
    await waitFor(() => expect(saveBtn).toBeEnabled());
  });

  it('Create with role source submits {principalId, roleId}', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });

    await user.type(screen.getByRole('combobox', { name: /user/i }), 'usr_charlie');
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /eng-member/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createAccessProfile.mock.calls[0]?.[0] as {
      contextId: string;
      body: Record<string, unknown>;
    };
    expect(call.contextId).toBe('engineering');
    expect(call.body.principalId).toBe('usr_charlie');
    expect(call.body.roleId).toBe('eng-member');
    expect(call.body.scopes).toBeUndefined();
  });

  it('Switching source from role to inline opens a ConfirmDialog; confirm discards + switches', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });

    // Set a role draft.
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /eng-member/i }));

    // Switch to inline — the hardened guard opens an a11y ConfirmDialog
    // (replacing the old native window.confirm), NOT a browser prompt.
    const inlineRadio = screen.getByRole('radio', {
      name: /inline scope clauses/i,
    }) as HTMLInputElement;
    await user.click(inlineRadio);

    // A dialog with an accessible name appears; the source has NOT switched yet.
    const dialog = await screen.findByRole('dialog', { name: /discard the other source/i });
    expect(window.confirm).not.toHaveBeenCalled();
    // Switch deferred: the inline radio is NOT yet selected; the role
    // Autocomplete is still rendered (not yet replaced by the ScopeEditor).
    expect(inlineRadio.checked).toBe(false);
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();

    // Confirm the discard → switch applies, role Autocomplete is replaced.
    await user.click(within(dialog).getByRole('button', { name: /discard and switch/i }));
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: /^role/i })).not.toBeInTheDocument(),
    );
    // The inline radio (stable DOM node) is now selected.
    expect(inlineRadio.checked).toBe(true);
  });

  it('Cancelling the source-switch ConfirmDialog keeps the abandoned role draft', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });

    // Set a role draft.
    await selectRoleOption(user, /eng-member/i);
    expect(screen.getByText('Engineering Team Member (eng-member)')).toBeInTheDocument();

    // Attempt to switch to inline, then CANCEL the confirmation.
    await user.click(screen.getByRole('radio', { name: /inline scope clauses/i }));
    const dialog = await screen.findByRole('dialog', { name: /discard the other source/i });
    await user.click(within(dialog).getByRole('button', { name: /keep editing/i }));

    // Dialog closes; the role source + its draft are preserved (no discard).
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /discard the other source/i }),
      ).not.toBeInTheDocument(),
    );
    expect((screen.getByRole('radio', { name: /use a role/i }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.getByText('Engineering Team Member (eng-member)')).toBeInTheDocument();
  });

  // Identity-override AUTHORING is disabled app-wide (this app's credential
  // can't grant a non-empty override — see CAN_AUTHOR_IDENTITY_OVERRIDES).
  // The namespace/value grammar validation itself (reserved namespaces,
  // scope-value grammar, etc.) is exhaustively covered at the pure-function
  // level in lib/identityOverrides.test.ts — with the fields disabled, a user
  // can no longer reach an invalid value through this UI at all, so the
  // integration surface here is just: shown, disabled, explained, never sent.
  it('Identity overrides section is shown but disabled, with an explanation, and never sent on create', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });

    await user.type(screen.getByRole('combobox', { name: /user/i }), 'usr_dana');
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /analyst/i }));

    await user.click(screen.getByRole('button', { name: /show advanced/i }));

    expect(screen.getByRole('textbox', { name: /org id/i })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /client id/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /add scope/i })).toBeDisabled();
    expect(
      screen.getByText(/identity overrides can't be set from this sign-in/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createAccessProfile.mock.calls[0]?.[0] as {
      body: { identityOverrides?: Record<string, unknown> };
    };
    expect(call.body.identityOverrides).toBeUndefined();
  });

  // The positive direction of the SAME gate — proves it's a live, per-session
  // check, not a fixed app fact: a session whose own credential holds an
  // identity can author one, and the value it enters IS sent.
  it('Identity overrides become editable, and ARE sent, when the session holds an identity', async () => {
    registerScope(['*'], { 'scope:org': 'org_new' });
    const user = userEvent.setup();
    const { client } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });

    await user.type(screen.getByRole('combobox', { name: /user/i }), 'usr_dana');
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /analyst/i }));

    await user.click(screen.getByRole('button', { name: /show advanced/i }));
    const orgInput = screen.getByRole('textbox', { name: /org id/i });
    await waitFor(() => expect(orgInput).toBeEnabled());
    expect(
      screen.queryByText(/identity overrides can't be set from this sign-in/i),
    ).not.toBeInTheDocument();

    await user.type(orgInput, 'org_new');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createAccessProfile.mock.calls[0]?.[0] as {
      body: { identityOverrides?: Record<string, unknown> };
    };
    expect(call.body.identityOverrides).toEqual({ 'scope:org': 'org_new' });
  });
});

describe('ProfileEditor — edit mode', () => {
  it('Prefills from getAccessProfile; derives role sourceType', async () => {
    renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    // Wait for the form to mount — baseline must be loaded first.
    const roleRadio = (await screen.findByRole('radio', {
      name: /use a role/i,
    })) as HTMLInputElement;
    expect(roleRadio.checked).toBe(true);
    // The autocomplete's selected value renders as a chip, not input text
    // (multi-select — see the module docstring).
    expect(await screen.findByText('Engineering Team Member (eng-member)')).toBeInTheDocument();
  });

  it('Edit submits updateAccessProfile envelope', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });

    // Wait for the form to mount (baseline loaded → fields rendered), then
    // swap the loaded role (eng-member) for a different single role: remove
    // its chip, select the other.
    await screen.findByRole('combobox', { name: /^role/i });
    await removeLastRoleChip(user);
    await selectRoleOption(user, /analyst/i);

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(client.auth.updateAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.updateAccessProfile.mock.calls[0]?.[0] as {
      contextId: string;
      principalId: string;
      body: { roleId?: string; roleIds?: string[] };
    };
    expect(call.contextId).toBe('engineering');
    expect(call.principalId).toBe('usr_alice');
    expect(call.body.roleId).toBe('analyst');
    expect(call.body.roleIds).toBeUndefined();
  });

  it('Identity overrides prefill from loaded profile + expand by default when set', async () => {
    renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    // Alice has a scope:org override → overrides section is auto-expanded.
    const orgInput = (await screen.findByRole('textbox', {
      name: /org id/i,
    })) as HTMLInputElement;
    expect(orgInput.value).toBe('org_eng');
    // Legible but not editable — this app's credential can't author it.
    expect(orgInput).toBeDisabled();
  });
});

// Multi-role composed profile (0.41.0): `roleId` is absent whenever 2+
// roles compose — only `roleIds` is present. Regression coverage for the
// bug where this was misread as an inline-scopes profile (empty/wrong
// scopes shown, composition silently dropped on save).
const PROFILE_ALICE_MULTIROLE = {
  contextId: 'engineering',
  principalId: 'usr_alice',
  roleIds: ['eng-member', 'analyst'],
};

describe('ProfileEditor — multi-role composition (roleIds) authoring', () => {
  it('loads both roles as chips in the (now single) role Autocomplete — Save disabled while clean', async () => {
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_ALICE_MULTIROLE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });

    const roleRadio = (await screen.findByRole('radio', {
      name: /use a role/i,
    })) as HTMLInputElement;
    expect(roleRadio.checked).toBe(true);

    // The multi-select Autocomplete renders (no more separate "read-only
    // notice" branch), pre-filled with both composing roles as chips.
    expect(await screen.findByRole('combobox', { name: /^role/i })).toBeInTheDocument();
    expect(screen.getByText('Engineering Team Member (eng-member)')).toBeInTheDocument();
    expect(screen.getByText('Analyst (analyst)')).toBeInTheDocument();

    // Never misread as inline — the ScopeEditor is not shown.
    expect(screen.queryByText('Scope clauses')).not.toBeInTheDocument();

    // Clean load — nothing touched yet — stays disabled, same as any other
    // freshly-loaded profile (dirty-state, not a can't-author restriction).
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('grant summary states the composition, not "no permissions yet"', async () => {
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_ALICE_MULTIROLE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    const summary = await screen.findByText(/inherits every permission from 2 composed roles/i);
    expect(summary.textContent).toMatch(/eng-member/);
    expect(summary.textContent).toMatch(/analyst/);
  });

  it('removing one role down to a single selection saves as `roleId`, not `roleIds`', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_ALICE_MULTIROLE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByText('Analyst (analyst)');

    // Backspace removes the last entry of the `value` array as rendered —
    // ROLE order (ROLE_ENG_MEMBER, ROLE_ANALYST) puts Analyst last.
    await removeLastRoleChip(user);
    await waitFor(() => expect(screen.queryByText('Analyst (analyst)')).not.toBeInTheDocument());
    expect(screen.getByText('Engineering Team Member (eng-member)')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateAccessProfile).toHaveBeenCalledTimes(1));
    const call = client.auth.updateAccessProfile.mock.calls[0]?.[0] as {
      body: { roleId?: string; roleIds?: string[] };
    };
    expect(call.body.roleId).toBe('eng-member');
    expect(call.body.roleIds).toBeUndefined();
  });

  it('adding a third role to a loaded composition saves as `roleIds` (2+, not the deprecated `roleId`)', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_ALICE_MULTIROLE),
        listRoles: vi.fn().mockResolvedValue(pageOf([ROLE_ENG_MEMBER, ROLE_ANALYST, ROLE_VIEWER])),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByText('Analyst (analyst)');

    await selectRoleOption(user, /^viewer/i);
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateAccessProfile).toHaveBeenCalledTimes(1));
    const call = client.auth.updateAccessProfile.mock.calls[0]?.[0] as {
      body: { roleId?: string; roleIds?: string[] };
    };
    expect(call.body.roleId).toBeUndefined();
    expect(call.body.roleIds).toEqual(expect.arrayContaining(['eng-member', 'analyst', 'viewer']));
    expect(call.body.roleIds).toHaveLength(3);
  });

  it('a composing role no longer in the roles list (deleted from the context) renders as a chip and survives an unrelated add — not silently dropped', async () => {
    // Regression coverage: deriving the Autocomplete's `value` from the
    // ROLES list (filtering for ids present in it) instead of from the
    // `roleIds` state itself would make an unresolvable id invisible, and
    // the next add/remove — which rebuilds `roleIds` from what's visibly
    // selected — would then silently drop it even though the user never
    // touched it.
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue({
          contextId: 'engineering',
          principalId: 'usr_alice',
          roleIds: ['eng-member', 'deleted-role'],
        }),
        // `deleted-role` is NOT in this list — as if it were removed from
        // the context after the profile was composed.
        listRoles: vi.fn().mockResolvedValue(pageOf([ROLE_ENG_MEMBER, ROLE_ANALYST])),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByText('Engineering Team Member (eng-member)');
    // The unresolvable id still renders — falls back to the bare id, same
    // as the old read-only notice used to (never silently invisible).
    expect(screen.getByText('deleted-role')).toBeInTheDocument();

    await selectRoleOption(user, /^analyst/i);
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateAccessProfile).toHaveBeenCalledTimes(1));
    const call = client.auth.updateAccessProfile.mock.calls[0]?.[0] as {
      body: { roleIds?: string[] };
    };
    // The stale reference survives an edit that never touched it.
    expect(call.body.roleIds).toEqual(
      expect.arrayContaining(['eng-member', 'deleted-role', 'analyst']),
    );
    expect(call.body.roleIds).toHaveLength(3);
  });

  it('switching to inline still opens the discard-confirm guard (composition is a draft too)', async () => {
    const user = userEvent.setup();
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_ALICE_MULTIROLE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByText('Analyst (analyst)');

    const inlineRadio = screen.getByRole('radio', {
      name: /inline scope clauses/i,
    }) as HTMLInputElement;
    await user.click(inlineRadio);

    // The "does the abandoned side hold a draft?" check must see the loaded
    // composition as a draft to abandon — switching away from a real 2-role
    // grant with no confirmation at all would be a silent-loss regression.
    const dialog = await screen.findByRole('dialog', { name: /discard the other source/i });
    expect(inlineRadio.checked).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: /discard and switch/i }));
    await waitFor(() => expect(inlineRadio.checked).toBe(true));
  });

  it('Clone stays disabled for a multi-role profile (the clone dialog itself does not yet support composing roles)', async () => {
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_ALICE_MULTIROLE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByText('Analyst (analyst)');
    expect(screen.getByRole('button', { name: /^clone$/i })).toBeDisabled();
  });
});

// Inline-source profile (no roleId) — exercises the inline `scopes` compare,
// the locus of the dirty-state bug.
const PROFILE_KEYBOT_INLINE = {
  contextId: 'engineering',
  principalId: 'key_bot',
  scopes: [{ allowed_actions: ['records:r'], data_scope: {} }],
};

describe('ProfileEditor — dirty-state regression', () => {
  it('clean on load: Save stays disabled on a pristine inline-scope profile', async () => {
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_KEYBOT_INLINE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/key_bot',
    });
    // sourceType derives to inline (no roleId) → the ScopeEditor mounts.
    const inlineRadio = (await screen.findByRole('radio', {
      name: /inline scope clauses/i,
    })) as HTMLInputElement;
    expect(inlineRadio.checked).toBe(true);
    // Wait for the ScopeEditor matrix to mount (its always-present Full access toggle).
    await screen.findByRole('checkbox', { name: /full access/i });
    // Before the fix: the inline `scopes` dirty check stringify-compared the full
    // clause ({allowed_actions, data_scope}) against an {allowed_actions}-only
    // baseline → never matched → permanently dirty → Save enabled on load.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('clean on load: Save stays disabled on a pristine role-source profile', async () => {
    // The default fixture (PROFILE_ALICE_ROLED) is role-source with an
    // identity override — the other half of the dirty compare. Before the fix this
    // was also permanently dirty (it still seeds [emptyClause()] for scopes).
    renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    const roleRadio = (await screen.findByRole('radio', {
      name: /use a role/i,
    })) as HTMLInputElement;
    expect(roleRadio.checked).toBe(true);
    // The loaded scope:org override is seeded; the form must still read clean.
    expect(
      ((await screen.findByRole('textbox', { name: /org id/i })) as HTMLInputElement).value,
    ).toBe('org_eng');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('becomes dirty when an inline scope action is edited', async () => {
    const user = userEvent.setup();
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_KEYBOT_INLINE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/key_bot',
    });
    await screen.findByRole('radio', { name: /inline scope clauses/i });
    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();
    // The loaded inline scope is records:r; granting Update on Records edits it.
    await user.click(await screen.findByRole('checkbox', { name: /update records/i }));
    await waitFor(() => expect(saveBtn).toBeEnabled());
  });

  it('a save carries granted_capabilities through untouched (0.40.0 round-trip safety — the actual regression this fixes)', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue({
          ...PROFILE_KEYBOT_INLINE,
          scopes: [
            {
              allowed_actions: ['records:r'],
              data_scope: {},
              granted_capabilities: ['forensic-read'],
            },
          ],
        }),
      }),
      initialUrl: '/access/contexts/engineering/profiles/key_bot',
    });
    await screen.findByRole('radio', { name: /inline scope clauses/i });
    // Edit something ELSE (never touch the capabilities checkboxes) to make
    // the form dirty and enable Save.
    await user.click(await screen.findByRole('checkbox', { name: /update records/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateAccessProfile).toHaveBeenCalledTimes(1));
    const call = client.auth.updateAccessProfile.mock.calls[0]?.[0] as {
      body: { scopes?: Array<{ granted_capabilities?: string[] }> };
    };
    expect(call.body.scopes?.[0]?.granted_capabilities).toEqual(['forensic-read']);
  });
});

// Canonical overrides: org via `scope:org`, plus a custom `scope:group`. Both
// must render in the editor and survive a save (the namespaced read/write path).
const PROFILE_CANONICAL_OVERRIDES = {
  contextId: 'engineering',
  principalId: 'usr_alice',
  roleId: 'eng-member',
  identityOverrides: {
    'scope:org': 'org_canon',
    'scope:group': 'eng-team',
  } as Record<string, unknown>,
};

describe('ProfileEditor — identity-override round-trip', () => {
  it('renders org + custom-namespace overrides from the canonical read-back', async () => {
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_CANONICAL_OVERRIDES),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    // Org field reads the `scope:org` value (previously undefined → blank).
    const orgInput = (await screen.findByRole('textbox', {
      name: /org id/i,
    })) as HTMLInputElement;
    expect(orgInput.value).toBe('org_canon');
    expect(orgInput).toBeDisabled();
    // The custom `scope:group` override renders as a namespace/value row —
    // legible but disabled, same as org/client above.
    const namespaceInput = screen.getByRole('textbox', { name: /namespace/i });
    const valueInput = screen.getByRole('textbox', { name: /^value$/i });
    expect((namespaceInput as HTMLInputElement).value).toBe('group');
    expect((valueInput as HTMLInputElement).value).toBe('eng-team');
    expect(namespaceInput).toBeDisabled();
    expect(valueInput).toBeDisabled();
  });

  it('stays clean on load (no spurious dirty) with canonical overrides', async () => {
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_CANONICAL_OVERRIDES),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('textbox', { name: /namespace/i });
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('a save that only touches an unrelated field never resubmits the untouched overrides', async () => {
    // The overrides section is disabled, so nothing in it CAN be edited —
    // this pins the buildBody() half of the fix: without it, saving ANY
    // other field (role, here) on a profile that already has non-empty
    // overrides would resend them unchanged and 403 for a reason the user
    // never touched.
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_CANONICAL_OVERRIDES),
        updateAccessProfile: vi.fn().mockResolvedValue(PROFILE_CANONICAL_OVERRIDES),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    // PROFILE_CANONICAL_OVERRIDES already holds 'eng-member' — swap to the
    // OTHER role (remove, then select) so this is a genuine, dirtying change,
    // and the save still ends up single-role (`roleId`, not `roleIds`).
    await screen.findByRole('combobox', { name: /^role/i });
    await removeLastRoleChip(user);
    await selectRoleOption(user, /analyst/i);

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateAccessProfile).toHaveBeenCalledTimes(1));
    const call = client.auth.updateAccessProfile.mock.calls[0]?.[0] as {
      body: { identityOverrides?: Record<string, unknown>; roleId?: string };
    };
    // The role change goes through...
    expect(call.body.roleId).toBe('analyst');
    // ...but the already-non-empty, untouched overrides are never resent.
    expect(call.body.identityOverrides).toBeUndefined();
  });

  it("...and the SAME holds even when the session COULD edit the overrides — being able to isn't the same as doing it", async () => {
    registerScope(['*'], { 'scope:org': 'org_eng' }); // matches PROFILE_ALICE_ROLED exactly
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('combobox', { name: /^role/i });
    await waitFor(() => expect(screen.getByRole('textbox', { name: /org id/i })).toBeEnabled());
    await removeLastRoleChip(user);
    await selectRoleOption(user, /analyst/i);

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.updateAccessProfile).toHaveBeenCalledTimes(1));
    const call = client.auth.updateAccessProfile.mock.calls[0]?.[0] as {
      body: { identityOverrides?: Record<string, unknown>; roleId?: string };
    };
    expect(call.body.roleId).toBe('analyst');
    expect(call.body.identityOverrides).toBeUndefined();
  });
});

// A stored value that breaks the client-side scope-VALUE grammar (a colon) —
// the grammar itself is exhaustively covered at the pure-function level in
// lib/identityOverrides.test.ts; these two pin the WIRING from that error
// into `canSubmit`, in both directions: it must not permanently block Save
// when the session can't fix it, but must still block when it genuinely
// could.
const PROFILE_INVALID_OVERRIDE = {
  contextId: 'engineering',
  principalId: 'usr_alice',
  roleId: 'eng-member',
  identityOverrides: { 'scope:org': 'a:b' } as Record<string, unknown>,
};

describe('ProfileEditor — a stale invalid stored override never permanently blocks Save', () => {
  it('does NOT block saving an unrelated field when this session cannot fix the override (fields disabled)', async () => {
    registerScope(['*']); // no identity — matches the disabled-fields case
    const user = userEvent.setup();
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_INVALID_OVERRIDE),
        updateAccessProfile: vi.fn().mockResolvedValue(PROFILE_INVALID_OVERRIDE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    // The inline error still renders — informational, not silently dropped.
    expect(await screen.findByText(/1.{0,3}128 characters/i)).toBeInTheDocument();

    screen.getByRole('combobox', { name: /^role/i });
    await selectRoleOption(user, /analyst/i);

    // Save enables despite the pre-existing override error — this session
    // has no way to fix it, so it must not block an unrelated edit.
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
  });

  it('DOES still block Save when this session holds an identity and genuinely could fix it', async () => {
    registerScope(['*'], { 'scope:org': 'a:b' }); // holds exactly the broken value
    const user = userEvent.setup();
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_INVALID_OVERRIDE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    expect(await screen.findByText(/1.{0,3}128 characters/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: /org id/i })).toBeEnabled());

    screen.getByRole('combobox', { name: /^role/i });
    await selectRoleOption(user, /analyst/i);

    // Stays disabled — this session COULD fix the override and hasn't.
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled());
  });
});

describe('ProfileEditor — clone dialog', () => {
  it('Materialize OFF (default) keeps roleId reference; identity overrides are NOT copied, and the dialog warns', async () => {
    // Source (usr_alice / PROFILE_ALICE_ROLED) has a non-empty scope:org
    // override — this app's credential can't author one, so carrying it
    // into the clone would just fail the whole create. The dialog warns and
    // drops it; everything else still clones.
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    // Clone is disabled until the profile baseline loads — wait for enabled.
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);
    const dialog = await screen.findByRole('dialog', { name: /clone access profile/i });

    expect(within(dialog).getByText(/won't be copied to the clone/i)).toBeInTheDocument();

    await user.type(within(dialog).getByRole('textbox', { name: /new principal id/i }), 'usr_eve');
    // Materialize toggle is OFF by default.
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));

    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createAccessProfile.mock.calls[0]?.[0] as {
      body: Record<string, unknown>;
    };
    expect(call.body.principalId).toBe('usr_eve');
    expect(call.body.roleId).toBe('eng-member');
    expect(call.body.scopes).toBeUndefined();
    expect(call.body.identityOverrides).toBeUndefined();
  });

  it('copies identity overrides to the clone, without warning, when the session holds a matching identity', async () => {
    registerScope(['*'], { 'scope:org': 'org_eng' }); // matches PROFILE_ALICE_ROLED exactly
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);
    const dialog = await screen.findByRole('dialog', { name: /clone access profile/i });

    expect(within(dialog).queryByText(/won't be copied to the clone/i)).not.toBeInTheDocument();

    await user.type(within(dialog).getByRole('textbox', { name: /new principal id/i }), 'usr_eve');
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));

    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createAccessProfile.mock.calls[0]?.[0] as {
      body: { identityOverrides?: Record<string, unknown> };
    };
    expect(call.body.identityOverrides).toEqual({ 'scope:org': 'org_eng' });
  });

  it('does not warn, and clones normally, when the source has no identity overrides', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_KEYBOT_INLINE),
      }),
      initialUrl: '/access/contexts/engineering/profiles/key_bot',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for key_bot/i });
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);
    const dialog = await screen.findByRole('dialog', { name: /clone access profile/i });

    expect(within(dialog).queryByText(/won't be copied to the clone/i)).not.toBeInTheDocument();

    await user.type(within(dialog).getByRole('textbox', { name: /new principal id/i }), 'key_bot2');
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));

    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createAccessProfile.mock.calls[0]?.[0] as {
      body: Record<string, unknown>;
    };
    expect(call.body.identityOverrides).toBeUndefined();
  });

  it('Materialize ON copies role scopes inline; roleId omitted', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    // Clone is disabled until the profile baseline loads — wait for enabled.
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);
    const dialog = await screen.findByRole('dialog', { name: /clone access profile/i });

    await user.type(within(dialog).getByRole('textbox', { name: /new principal id/i }), 'usr_eve');
    // Toggle materialize ON. MUI Switch's accessible name attaches via
    // the FormControlLabel; clicking the label toggles the underlying
    // input. getByLabelText finds it through the label association.
    await user.click(within(dialog).getByLabelText(/materialize role into inline scopes/i));
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));

    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createAccessProfile.mock.calls[0]?.[0] as {
      body: {
        roleId?: string;
        scopes?: Array<{ allowed_actions: string[] }>;
      };
    };
    expect(call.body.roleId).toBeUndefined();
    expect(call.body.scopes?.[0]?.allowed_actions).toEqual(['records:r', 'documents:r']);
  });
});

// Alice, without the identityOverrides the default fixture carries — used by
// the delete tests below that need the unconditional (no-overrides) path.
const PROFILE_ALICE_NO_OVERRIDES = {
  contextId: 'engineering',
  principalId: 'usr_alice',
  roleId: 'eng-member',
};

describe('ProfileEditor — delete dialog', () => {
  it('Submits envelope unconditionally and navigates to ?tab=profiles', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_ALICE_NO_OVERRIDES),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete access profile/i });

    // Body mentions the ~5-min cache window.
    expect(within(dialog).getByText(/within ~5 minutes/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /delete profile/i }));

    await waitFor(() => {
      expect(client.auth.deleteAccessProfile).toHaveBeenCalledWith({
        contextId: 'engineering',
        principalId: 'usr_alice',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('probe-pathname')).toHaveTextContent(
        '/access/contexts/engineering?tab=profiles',
      );
    });
  });

  it("disables Delete, with an explanation, when the session identity does not match the profile's overrides", async () => {
    // The default fixture (PROFILE_ALICE_ROLED) has a non-empty scope:org
    // override; the default session (registerScope(['*']) in beforeEach, no
    // identity) holds nothing that matches it — removing it would displace
    // an identity value this session can't prove it holds.
    const user = userEvent.setup();
    renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete access profile/i });

    expect(within(dialog).getByText(/this sign-in doesn't hold/i)).toBeInTheDocument();
    // Disabled — a real click can't even land on it (pointer-events: none),
    // which is the guard itself; nothing more to prove by attempting one. (A
    // trailing `deleteAccessProfile).not.toHaveBeenCalled()` here would be
    // vacuous — true regardless of this guard, since the mutation is never
    // invoked without a click reaching the button.)
    expect(within(dialog).getByRole('button', { name: /delete profile/i })).toBeDisabled();
  });

  it("allows Delete when the session holds an identity matching the profile's overrides — the false-deny fix", async () => {
    // Same PROFILE_ALICE_ROLED (scope:org: org_eng); this session holds
    // EXACTLY that value — the platform's displacement rule is satisfied, so
    // this delete is really authorized, not merely appearing to be.
    registerScope(['*'], { 'scope:org': 'org_eng' });
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete access profile/i });

    const confirmBtn = within(dialog).getByRole('button', { name: /delete profile/i });
    await waitFor(() => expect(confirmBtn).toBeEnabled());
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(client.auth.deleteAccessProfile).toHaveBeenCalledWith({
        contextId: 'engineering',
        principalId: 'usr_alice',
      });
    });
  });

  it('Delete keeps the dialog OPEN and announces the error (role=alert + requestId) on failure', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'Backend down',
      statusCode: 500,
      body: { message: 'Backend down', requestId: 'req-del-123' },
    });
    const { client } = renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue(PROFILE_ALICE_NO_OVERRIDES),
        deleteAccessProfile: vi.fn().mockRejectedValue(err),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete access profile/i });
    await user.click(within(dialog).getByRole('button', { name: /delete profile/i }));

    // The error is announced INSIDE the still-open dialog, with the requestId.
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    });
    expect(within(dialog).getByText(/req-del-123/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /delete access profile/i })).toBeInTheDocument();
    expect(client.auth.deleteAccessProfile).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileEditor — hardening states', () => {
  it('shows a labeled loading spinner while the profile is fetching', async () => {
    let resolve: ((v: unknown) => void) | undefined;
    const pending = new Promise((r) => {
      resolve = r;
    });
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockReturnValue(pending),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    expect(await screen.findByLabelText(/loading profiles/i)).toBeInTheDocument();
    resolve?.(PROFILE_ALICE_ROLED);
  });

  it('surfaces an ApiErrorAlert (role=alert + requestId) when the profile load fails', async () => {
    const err = new VectrosError({
      message: 'Boom',
      statusCode: 503,
      body: { message: 'Boom', requestId: 'req-load-77' },
    });
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockRejectedValue(err),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load this profile/i);
    expect(alert).toHaveTextContent(/req-load-77/);
  });

  it('Save shows a pending/disabled SubmitButton while the mutation is in flight', async () => {
    const user = userEvent.setup();
    let resolve: ((v: unknown) => void) | undefined;
    const { client } = renderEditor({
      client: makeMockClient({
        updateAccessProfile: vi.fn().mockReturnValue(
          new Promise((r) => {
            resolve = r;
          }),
        ),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('combobox', { name: /^role/i });
    await selectRoleOption(user, /analyst/i);

    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await user.click(saveBtn);

    // While in flight the SubmitButton disables + sets aria-busy.
    await waitFor(() => expect(saveBtn).toBeDisabled());
    expect(saveBtn).toHaveAttribute('aria-busy', 'true');
    resolve?.(PROFILE_ALICE_ROLED);
    void client;
  });

  it('surfaces a specific duplicate-id message on a 409 when creating a profile', async () => {
    const user = userEvent.setup();
    const conflict = new VectrosError({
      message: 'already exists',
      statusCode: 409,
      body: { message: 'already exists', requestId: 'req-dup-9' },
    });
    renderEditor({
      client: makeMockClient({
        createAccessProfile: vi.fn().mockRejectedValue(conflict),
      }),
      initialUrl: '/access/contexts/engineering/profiles/new',
    });
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });
    await user.type(screen.getByRole('combobox', { name: /user/i }), 'usr_charlie');
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /eng-member/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/principal id already exists/i);
    // The generic save-error copy must NOT be shown for the conflict case.
    expect(alert).not.toHaveTextContent(/could not save this profile/i);
  });

  it('surfaces the server-specific reason beneath the generic title on a non-conflict save failure (0.40.0 — e.g. a usr_ principal that is not a live user)', async () => {
    const user = userEvent.setup();
    const notALiveUser = new VectrosError({
      message: 'bad request',
      statusCode: 400,
      body: {
        message: 'principalId does not name a live user in your tenant.',
        requestId: 'req-400-1',
      },
    });
    renderEditor({
      client: makeMockClient({
        createAccessProfile: vi.fn().mockRejectedValue(notALiveUser),
      }),
      initialUrl: '/access/contexts/engineering/profiles/new',
    });
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });
    await user.type(screen.getByRole('combobox', { name: /user/i }), 'usr_ghost');
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /eng-member/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const alert = await screen.findByRole('alert');
    // The generic title AND the server's specific reason both render.
    expect(alert).toHaveTextContent(/could not save this profile/i);
    expect(alert).toHaveTextContent(/does not name a live user/i);
    expect(alert).toHaveTextContent(/req-400-1/);
  });

  it('shows only the generic save-error title (no stray detail line) when the error carries no body message', async () => {
    const user = userEvent.setup();
    const bare = new VectrosError({ message: 'boom', statusCode: 500 });
    renderEditor({
      client: makeMockClient({
        createAccessProfile: vi.fn().mockRejectedValue(bare),
      }),
      initialUrl: '/access/contexts/engineering/profiles/new',
    });
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });
    await user.type(screen.getByRole('combobox', { name: /user/i }), 'usr_charlie');
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /eng-member/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not save this profile/i);
  });

  it('keeps the Clone dialog OPEN and announces a clone error on failure', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'nope',
      statusCode: 500,
      body: { message: 'nope', requestId: 'req-clone-1' },
    });
    renderEditor({
      client: makeMockClient({
        createAccessProfile: vi.fn().mockRejectedValue(err),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    // Clone is disabled until the profile baseline loads — wait for enabled.
    const cloneOpenBtn = screen.getByRole('button', { name: /^clone$/i });
    await waitFor(() => expect(cloneOpenBtn).toBeEnabled());
    await user.click(cloneOpenBtn);
    const dialog = await screen.findByRole('dialog', { name: /clone access profile/i });
    await user.type(within(dialog).getByRole('textbox', { name: /new principal id/i }), 'usr_eve');
    await user.click(within(dialog).getByRole('button', { name: /^clone$/i }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeInTheDocument());
    expect(within(dialog).getByText(/req-clone-1/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /clone access profile/i })).toBeInTheDocument();
  });

  it('disables Clone + Delete until the profile baseline has loaded', async () => {
    let resolve: ((v: unknown) => void) | undefined;
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockReturnValue(
          new Promise((r) => {
            resolve = r;
          }),
        ),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    // Header Clone/Delete are present but disabled while the profile loads.
    const cloneBtn = await screen.findByRole('button', { name: /^clone$/i });
    expect(cloneBtn).toBeDisabled();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeDisabled();
    resolve?.(PROFILE_ALICE_ROLED);
    await waitFor(() => expect(cloneBtn).toBeEnabled());
  });
});

describe('ProfileEditor — principal picker + grant summary', () => {
  it('assigns a user by email — the picker resolves to the usr_ principal', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });

    // Pick a user from the directory by their email (not a raw usr_ id).
    const principal = screen.getByRole('combobox', { name: /user/i });
    await user.click(principal);
    await user.click(await screen.findByRole('option', { name: /charlie@example\.com/i }));

    // Pick a role, then save.
    const roleInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(roleInput);
    await user.click(await screen.findByRole('option', { name: /analyst/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(client.auth.createAccessProfile).toHaveBeenCalled());
    const call = (client.auth.createAccessProfile as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { body: { principalId: string } };
    expect(call.body.principalId).toBe('usr_charlie');
  });

  it('edit mode shows the resolved user email instead of the raw usr_ id', async () => {
    renderEditor({ initialUrl: '/access/contexts/engineering/profiles/usr_alice' });
    // usr_alice resolves to alice@example.com via the directory.
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
  });

  it('summarizes a wildcard inline profile as "Full access"', async () => {
    renderEditor({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockResolvedValue({
          contextId: 'engineering',
          principalId: 'usr_alice',
          scopes: [{ allowed_actions: ['*'], data_scope: {} }],
        }),
      }),
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    expect(await screen.findByText(/full access — every action/i)).toBeInTheDocument();
  });
});
