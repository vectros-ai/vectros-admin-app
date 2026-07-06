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

const PROFILE_ALICE_ROLED = {
  contextId: 'engineering',
  principalId: 'usr_alice',
  roleId: 'eng-member',
  identityOverrides: { orgId: 'org_eng' } as Record<string, unknown>,
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
      getAccessProfile:
        o.getAccessProfile ?? vi.fn().mockResolvedValue(PROFILE_ALICE_ROLED),
      createAccessProfile:
        o.createAccessProfile ??
        vi.fn().mockImplementation(({ body }: { body: { principalId: string } }) =>
          Promise.resolve({ contextId: 'engineering', ...body }),
        ),
      updateAccessProfile:
        o.updateAccessProfile ?? vi.fn().mockResolvedValue(PROFILE_ALICE_ROLED),
      deleteAccessProfile:
        o.deleteAccessProfile ?? vi.fn().mockResolvedValue(undefined),
      listRoles:
        o.listRoles ??
        vi.fn().mockResolvedValue(pageOf([ROLE_ENG_MEMBER, ROLE_ANALYST])),
    },
  };
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
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
    await user.type(
      screen.getByRole('combobox', { name: /user/i }),
      'usr_charlie',
    );
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

    await user.type(
      screen.getByRole('combobox', { name: /user/i }),
      'usr_charlie',
    );
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
    const tplInput = screen.getByRole('combobox', { name: /^role/i }) as HTMLInputElement;
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /eng-member/i }));
    expect(tplInput.value).toContain('eng-member');

    // Attempt to switch to inline, then CANCEL the confirmation.
    await user.click(screen.getByRole('radio', { name: /inline scope clauses/i }));
    const dialog = await screen.findByRole('dialog', { name: /discard the other source/i });
    await user.click(within(dialog).getByRole('button', { name: /keep editing/i }));

    // Dialog closes; the role source + its draft are preserved (no discard).
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /discard the other source/i })).not.toBeInTheDocument(),
    );
    expect((screen.getByRole('radio', { name: /use a role/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('combobox', { name: /^role/i }) as HTMLInputElement).value).toContain('eng-member');
  });

  it('Identity overrides expand + submit under identityOverrides', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: /create access profile/i });

    await user.type(
      screen.getByRole('combobox', { name: /user/i }),
      'usr_dana',
    );
    const tplInput = screen.getByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.click(await screen.findByRole('option', { name: /analyst/i }));

    // Expand overrides; fill one of the two TextFields.
    await user.click(screen.getByRole('button', { name: /show advanced/i }));
    await user.type(
      screen.getByRole('textbox', { name: /org id/i }),
      'org_field',
    );
    // Leave clientId blank — should be omitted from the payload.

    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.createAccessProfile.mock.calls[0]?.[0] as {
      body: { identityOverrides?: Record<string, unknown> };
    };
    expect(call.body.identityOverrides).toEqual({ orgId: 'org_field' });
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
    // The autocomplete's selected value renders as the combobox's input value.
    const tplInput = screen.getByRole('combobox', { name: /^role/i }) as HTMLInputElement;
    expect(tplInput.value).toContain('eng-member');
  });

  it('Edit submits updateAccessProfile envelope', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });

    // Wait for the form to mount (baseline loaded → fields rendered).
    const tplInput = await screen.findByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.clear(tplInput);
    await user.type(tplInput, 'analyst');
    await user.click(await screen.findByRole('option', { name: /analyst/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(client.auth.updateAccessProfile).toHaveBeenCalledTimes(1);
    });
    const call = client.auth.updateAccessProfile.mock.calls[0]?.[0] as {
      contextId: string;
      principalId: string;
      body: { roleId: string };
    };
    expect(call.contextId).toBe('engineering');
    expect(call.principalId).toBe('usr_alice');
    expect(call.body.roleId).toBe('analyst');
  });

  it('Identity overrides prefill from loaded profile + expand by default when set', async () => {
    renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    // Alice has orgId='org_eng' → overrides section is auto-expanded.
    const orgInput = (await screen.findByRole('textbox', {
      name: /org id/i,
    })) as HTMLInputElement;
    expect(orgInput.value).toBe('org_eng');
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
    // The loaded orgId override is seeded; the form must still read clean.
    expect(
      (await screen.findByRole('textbox', { name: /org id/i }) as HTMLInputElement)
        .value,
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
});

describe('ProfileEditor — clone dialog', () => {
  it('Materialize OFF (default) keeps roleId reference', async () => {
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

    await user.type(
      within(dialog).getByRole('textbox', { name: /new principal id/i }),
      'usr_eve',
    );
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
    // identityOverrides copied verbatim from source.
    expect(call.body.identityOverrides).toEqual({ orgId: 'org_eng' });
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

    await user.type(
      within(dialog).getByRole('textbox', { name: /new principal id/i }),
      'usr_eve',
    );
    // Toggle materialize ON. MUI Switch's accessible name attaches via
    // the FormControlLabel; clicking the label toggles the underlying
    // input. getByLabelText finds it through the label association.
    await user.click(
      within(dialog).getByLabelText(/materialize role into inline scopes/i),
    );
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

describe('ProfileEditor — delete dialog', () => {
  it('Submits envelope unconditionally and navigates to ?tab=profiles', async () => {
    const user = userEvent.setup();
    const { client } = renderEditor({
      initialUrl: '/access/contexts/engineering/profiles/usr_alice',
    });
    await screen.findByRole('heading', { level: 1, name: /edit profile for usr_alice/i });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete access profile/i });

    // Body mentions the ~5-min cache window.
    expect(
      within(dialog).getByText(/within ~5 minutes/i),
    ).toBeInTheDocument();
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

  it('Delete keeps the dialog OPEN and announces the error (role=alert + requestId) on failure', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'Backend down',
      statusCode: 500,
      body: { message: 'Backend down', requestId: 'req-del-123' },
    });
    const { client } = renderEditor({
      client: makeMockClient({
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
    expect(
      await screen.findByLabelText(/loading profiles/i),
    ).toBeInTheDocument();
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
    const tplInput = await screen.findByRole('combobox', { name: /^role/i });
    await user.click(tplInput);
    await user.clear(tplInput);
    await user.type(tplInput, 'analyst');
    await user.click(await screen.findByRole('option', { name: /analyst/i }));

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
    await user.type(
      screen.getByRole('combobox', { name: /user/i }),
      'usr_charlie',
    );
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
    await user.type(
      within(dialog).getByRole('textbox', { name: /new principal id/i }),
      'usr_eve',
    );
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
