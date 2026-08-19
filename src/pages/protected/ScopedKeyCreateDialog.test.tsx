// ---------------------------------------------------------------------------
// ScopedKeyCreateDialog tests (Steps 3 + 4 scope).
//
// Pinning:
//   1. validateKeyName / formatKeyNameError helpers — full discriminant set
//      across the backend rule (required / whitespace / tooLong / null).
//   2. <ScopedKeyCreateDialog>:
//      - 5-step stepper labels rendered.
//      - Cancel calls onClose.
//      - BasicsStep field + env radio with live preselected (default prop).
//      - Next disabled until keyName valid; enabled after.
//      - Inline error renders for whitespace + tooLong cases.
//      - BindStep (Step 4 — this commit):
//        - Humans tab default + list renders + click selects + Next enables
//        - Switching to Services tab swaps the visible rows
//        - Empty state copy per tab
//        - "Create service principal" opens ServicePrincipalCreateDialog
//        - The sub-dialog submits identity.createUser w/ externalId + SERVICE
//        - On success the new user is auto-selected + tab flips to Services
//      - Full nav flow basics → bind → context → review → confirmation.
//      - "confirmation" shows the Done button (Cancel/Back/Next gone); Done
//        calls onClose.
//      - Back returns to the prior step from any non-basics step.
// ---------------------------------------------------------------------------

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntl, createIntlCache } from 'react-intl';

import { TestIntlProvider } from '../../test/intl';
import { I18N_DEFAULT_LOCALE } from '../../i18n/IntlProvider';
import enMessages from '../../i18n/messages.en.json';
import { VectrosError, vectrosApiClient } from '../../api/vectrosApi';
import { pageOf } from '../../test/pageOf';
import type * as VectrosApi from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DevApi from '../../api/developerApi';
import { TestTenantProvider, TEST_TENANT_ID, TEST_MEMBERSHIPS } from '../../test/TestTenantProvider';
import {
  ScopedKeyCreateDialog,
  formatKeyNameError,
  validateKeyName,
} from './ScopedKeyCreateDialog';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

// Contexts are enumerated via the owner-gated developer API (the partner list is
// context-confined); the context-scoped create calls still use the per-context
// vectrosApiClient bearer above.
vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DevApi>();
  return {
    ...actual,
    useDeveloperApi: vi.fn(),
  };
});

const SAMPLE_USERS = [
  { id: 'u_alice', email: 'alice@example.com', type: 'HUMAN', status: 'ACTIVE' },
  { id: 'u_bob', email: 'bob@example.com', type: 'HUMAN', status: 'ACTIVE' },
  { id: 'u_bot', externalId: 'research-bot', type: 'SERVICE', status: 'ACTIVE' },
];

// The reserved control-plane context is deliberately absent here: it's never
// a pickable target (a scoped key needs a data context, and the partner API
// rejects an explicit mint pinned to the reserved context outright) — see
// the "never offers the reserved context" test below, which simulates the
// developer API still returning it and asserts the picker excludes it anyway.
const SAMPLE_CONTEXTS = [
  { contextId: 'partner-api', name: 'Partner API' },
  { contextId: 'data-eng', name: 'Data Engineering' },
];

const SAMPLE_PROFILE = {
  principalId: 'usr_u_alice',
  status: 'active',
  roleId: 'tmpl-owner',
  scopes: [],
};

const SAMPLE_CREATED_KEY = {
  keyId: 'ssk_test_abc123',
  keyName: 'good-name',
  tenantId: 'test',
  contextId: 'partner-api',
  userId: 'u_alice',
  userType: 'HUMAN',
  status: 'active',
  keyType: 'scoped',
  rawKey: 'ssk_test_RAW_SECRET_VALUE_xyz',
  accessProfileRef: 'test#partner-api#usr_u_alice',
  createdAt: '2026-05-30T08:00:00Z',
};

const SAMPLE_IDEMPOTENT_KEY = {
  // Same shape as SAMPLE_CREATED_KEY but NO rawKey — the backend returns
  // 200 + the existing metadata when (partner, tenant, context, userId,
  // keyName) already maps to an active key.
  keyId: 'ssk_test_existing',
  keyName: 'good-name',
  tenantId: 'test',
  contextId: 'partner-api',
  userId: 'u_alice',
  userType: 'HUMAN',
  status: 'active',
  keyType: 'scoped',
  accessProfileRef: 'test#partner-api#usr_u_alice',
  createdAt: '2026-05-29T10:00:00Z',
};

function makeMockClient(overrides: {
  listUsers?: ReturnType<typeof vi.fn>;
  createUser?: ReturnType<typeof vi.fn>;
  getAccessProfile?: ReturnType<typeof vi.fn>;
  createAccessProfile?: ReturnType<typeof vi.fn>;
  createScopedKey?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    identity: {
      listUsers: overrides.listUsers ?? vi.fn().mockResolvedValue(pageOf(SAMPLE_USERS)),
      createUser:
        overrides.createUser ??
        vi.fn().mockResolvedValue({
          id: 'u_new_service',
          externalId: 'new-service-bot',
          type: 'SERVICE',
          status: 'ACTIVE',
        }),
    },
    auth: {
      // Default: profile exists. Tests that want the "missing" / "error"
      // paths override this with a 404 VectrosError or a non-404 error.
      getAccessProfile:
        overrides.getAccessProfile ?? vi.fn().mockResolvedValue(SAMPLE_PROFILE),
      createAccessProfile:
        overrides.createAccessProfile ??
        vi.fn().mockResolvedValue({ ...SAMPLE_PROFILE }),
      // Default: returns a fresh-create response with the rawKey present.
      // Tests for the idempotent-match path override to return the
      // SAMPLE_IDEMPOTENT_KEY (no rawKey).
      createScopedKey:
        overrides.createScopedKey ?? vi.fn().mockResolvedValue(SAMPLE_CREATED_KEY),
    },
  };
}

function renderDialog(
  opts: {
    onClose?: () => void;
    onSuccess?: () => void;
    initialEnv?: 'live' | 'test';
    client?: ReturnType<typeof makeMockClient>;
  } = {},
) {
  const onClose = opts.onClose ?? vi.fn();
  const onSuccess = opts.onSuccess ?? vi.fn();
  const client = opts.client ?? makeMockClient();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  // The context picker enumerates via the developer API; the context-scoped
  // create calls above still go through the per-context vectrosApiClient bearer.
  vi.mocked(useDeveloperApi).mockReturnValue({
    listAppContexts: vi.fn().mockResolvedValue(pageOf(SAMPLE_CONTEXTS)),
    createAppContext: vi.fn(),
    deleteAppContext: vi.fn(),
    listScopedKeys: vi.fn(),
    revokeScopedKey: vi.fn(),
    getAdminLogs: vi.fn(),
  } as never);
  const utils = render(
    <TestIntlProvider>
      <TestTenantProvider>
        <ScopedKeyCreateDialog
          open
          onClose={onClose}
          onSuccess={onSuccess}
          initialEnv={opts.initialEnv ?? 'live'}
        />
      </TestTenantProvider>
    </TestIntlProvider>,
  );
  return { ...utils, onClose, onSuccess, client };
}

/**
 * Walks the wizard from BasicsStep through BindStep — types a valid key
 * name, advances to bind, waits for the user list, clicks Alice, and
 * advances to context. Used by the nav-flow tests that need to traverse
 * past Step 4.
 */
async function advancePastBind(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
  await user.click(screen.getByRole('button', { name: /^next$/i }));
  // Wait for the user list to load (the Loading users spinner goes away).
  await screen.findByText('alice@example.com');
  // Click Alice.
  await user.click(screen.getByText('alice@example.com'));
  // Next becomes enabled once Alice is selected.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: /^next$/i }));
}

/**
 * Walks the wizard from ContextStep into ReviewStep — assumes the wizard
 * is currently mounted at the context step (after advancePastBind has
 * been called). Opens the context dropdown, picks partner-api (the first
 * SAMPLE_CONTEXTS entry), waits for the profile-exists alert to render,
 * then clicks Next.
 *
 * Default mocked behavior: SAMPLE_CONTEXTS contains partner-api and the
 * default getAccessProfile mock returns SAMPLE_PROFILE so the profile-
 * exists path fires immediately.
 */
async function advancePastContext(
  user: ReturnType<typeof userEvent.setup>,
  context: RegExp = /^partner-api/,
): Promise<void> {
  // Open MUI Select via its accessible role (combobox).
  await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
  // The listbox shows the contexts — pick the requested one.
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByText(context));
  // Wait for the profile-exists success alert to render.
  await screen.findByText(/AccessProfile exists for this/i);
  // Next now enables; click it.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: /^next$/i }));
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// validateKeyName / formatKeyNameError
// ---------------------------------------------------------------------------

describe('validateKeyName()', () => {
  it('rejects empty string', () => {
    expect(validateKeyName('')).toBe('required');
  });

  it('rejects whitespace-only string', () => {
    expect(validateKeyName('   ')).toBe('required');
  });

  it('rejects leading whitespace', () => {
    expect(validateKeyName(' name')).toBe('whitespace');
  });

  it('rejects trailing whitespace', () => {
    expect(validateKeyName('name ')).toBe('whitespace');
  });

  it('rejects names longer than 100 characters', () => {
    expect(validateKeyName('x'.repeat(101))).toBe('tooLong');
  });

  it('accepts a typical name', () => {
    expect(validateKeyName('research-bot prod')).toBeNull();
  });

  it('accepts a 100-char name (boundary)', () => {
    expect(validateKeyName('x'.repeat(100))).toBeNull();
  });
});

describe('formatKeyNameError()', () => {
  const intl = createIntl(
    { locale: I18N_DEFAULT_LOCALE, messages: enMessages as Record<string, string> },
    createIntlCache(),
  );

  it('formats required', () => {
    expect(formatKeyNameError('required', intl)).toBe('Key name is required');
  });

  it('formats whitespace', () => {
    expect(formatKeyNameError('whitespace', intl)).toBe(
      'No leading or trailing whitespace',
    );
  });

  it('formats tooLong', () => {
    expect(formatKeyNameError('tooLong', intl)).toBe(
      'Must be 100 characters or fewer',
    );
  });
});

// ---------------------------------------------------------------------------
// <ScopedKeyCreateDialog> — Stepper + Cancel + BasicsStep
// ---------------------------------------------------------------------------

describe('<ScopedKeyCreateDialog>', () => {
  it('renders the dialog with the 5-step stepper', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: /create scoped key/i })).toBeInTheDocument();
    expect(screen.getByText('Basics')).toBeInTheDocument();
    expect(screen.getByText('Bind to user')).toBeInTheDocument();
    expect(screen.getByText('App context')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Confirmation')).toBeInTheDocument();
  });

  it('Cancel button calls onClose', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('BasicsStep — preselects the env radio from initialEnv', () => {
    renderDialog({ initialEnv: 'test' });
    const testRadio = screen.getByRole('radio', { name: /^test$/i });
    expect(testRadio).toBeChecked();
  });

  it('Next is disabled when key name is empty', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
  });

  it('Next becomes enabled when a valid key name is typed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'research-bot prod');
    expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
  });

  it('shows the whitespace error inline when key name has trailing space', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'name ');
    expect(
      await screen.findByText(/no leading or trailing whitespace/i),
    ).toBeInTheDocument();
  });

  it('shows the tooLong error inline when key name exceeds 100 chars', async () => {
    const user = userEvent.setup();
    renderDialog();
    // Paste (one event) rather than typing 101 chars key-by-key — same change
    // event + validation, but fast/deterministic instead of ~101 keystrokes.
    const input = screen.getByLabelText(/^key name$/i);
    await user.click(input);
    await user.paste('x'.repeat(101));
    expect(
      await screen.findByText(/must be 100 characters or fewer/i),
    ).toBeInTheDocument();
  });

  // ----- BindStep --------------------------------------

  it('BindStep — Humans tab is the default + lists HUMAN users on enter', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    // SERVICE user not visible on Humans tab.
    expect(screen.queryByText('research-bot')).not.toBeInTheDocument();
  });

  it('BindStep — Next is disabled until a user is picked', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');

    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    await user.click(screen.getByText('alice@example.com'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled(),
    );
  });

  it('BindStep — Enter key on a user row selects them (a11y)', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');

    // Focus Alice's option, then activate via keyboard. Pins the
    // role="option" + tabIndex=0 + onKeyDown wiring that exists for
    // a11y compliance (the dev-portal's onClick-only Box pattern lost
    // keyboard access; this fixes it).
    const aliceOption = screen.getByText('alice@example.com').closest('[role="option"]');
    expect(aliceOption).not.toBeNull();
    (aliceOption as HTMLElement).focus();
    await user.keyboard('{Enter}');

    // Next becomes enabled — same end-state as the click path test.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled(),
    );
  });

  it('BindStep — switching to Services tab swaps the visible users', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');

    await user.click(screen.getByRole('tab', { name: /services/i }));
    expect(await screen.findByText('research-bot')).toBeInTheDocument();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
  });

  it('BindStep — empty state copy per tab', async () => {
    const user = userEvent.setup();
    renderDialog({
      client: makeMockClient({ listUsers: vi.fn().mockResolvedValue(pageOf([])) }),
    });
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByText(/no human users yet/i)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /services/i }));
    expect(await screen.findByText(/no service principals yet/i)).toBeInTheDocument();
  });

  it('BindStep — "Create service principal" opens the sub-dialog', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('tab', { name: /services/i }));

    await user.click(screen.getByRole('button', { name: /create service principal/i }));
    // The sub-dialog title surfaces via role=dialog.
    const subDialog = await screen.findByRole('dialog', { name: /create service principal/i });
    expect(subDialog).toBeInTheDocument();
    expect(within(subDialog).getByLabelText(/^external id$/i)).toBeInTheDocument();
  });

  it('BindStep — ServicePrincipalCreateDialog submits createUser with type=SERVICE + auto-selects + flips tab', async () => {
    const user = userEvent.setup();
    const { client } = renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('tab', { name: /services/i }));
    await user.click(screen.getByRole('button', { name: /create service principal/i }));

    const subDialog = await screen.findByRole('dialog', { name: /create service principal/i });
    await user.type(within(subDialog).getByLabelText(/^external id$/i), 'new-service-bot');
    await user.click(within(subDialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      // The request body nests under `body` (SDK 0.31 un-inlined it when `?upsert` was added).
      expect(client.identity.createUser).toHaveBeenCalledWith({
        body: {
          externalId: 'new-service-bot',
          type: 'SERVICE',
        },
      });
    });
    // After success the sub-dialog closes + Next becomes enabled (the new
    // user was auto-selected as boundUser).
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /create service principal/i }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled(),
    );
  });

  it('BindStep — a created principal survives the initial (still in-flight) listUsers fetch resolving late with the pre-create list (#1002 race)', async () => {
    // #1002's fix writes the created principal straight into the cache. But
    // BindStep's OWN initial listUsers fetch — the one that's already
    // running when the dialog mounts — can still be in flight when that
    // write happens (it may be draining several pages), and its eventual
    // resolution carries the PRE-create list. If the fix didn't also cancel
    // that stale fetch, its late resolution would silently overwrite the
    // write and reproduce #1002's exact symptom. Prove it doesn't: create
    // while the initial fetch is deliberately held open, THEN let the stale
    // fetch resolve, and assert the created row survives.
    let resolveInitialFetch!: (v: { data: readonly (typeof SAMPLE_USERS)[number][]; nextCursor: null }) => void;
    const initialFetch = new Promise<{ data: readonly (typeof SAMPLE_USERS)[number][]; nextCursor: null }>((resolve) => {
      resolveInitialFetch = resolve;
    });
    const listUsers = vi.fn().mockReturnValue(initialFetch);

    const user = userEvent.setup();
    renderDialog({ client: makeMockClient({ listUsers }) });
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    await user.click(screen.getByRole('tab', { name: /services/i }));
    await user.click(screen.getByRole('button', { name: /create service principal/i }));
    const subDialog = await screen.findByRole('dialog', { name: /create service principal/i });
    await user.type(within(subDialog).getByLabelText(/^external id$/i), 'new-service-bot');
    await user.click(within(subDialog).getByRole('button', { name: /^create$/i }));

    // The regression proof itself: the row appears without ever waiting for
    // the initial fetch — proving the cache write, not that fetch, is what
    // renders it.
    const row = await screen.findByRole('option', { name: /new-service-bot/i });
    expect(row).toHaveAttribute('aria-selected', 'true');

    // Now let the initial fetch resolve, carrying the PRE-create list
    // (SAMPLE_USERS). Two things must both hold once this settles: the
    // just-created row must still be there (this fetch's resolution must
    // not silently become the sole truth), AND SAMPLE_USERS' own rows —
    // including 'research-bot', another pre-existing SERVICE row — must
    // ALSO still be there. An earlier version of this fix got the first
    // half right by cancelling this fetch outright, which broke the second
    // half: cancelling the tenant's only in-flight fetch to protect the
    // optimistic write also discarded every real user that fetch would
    // have returned.
    await act(async () => {
      resolveInitialFetch(pageOf(SAMPLE_USERS));
    });

    await waitFor(() =>
      expect(screen.getByRole('option', { name: /new-service-bot/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('option', { name: /research-bot/i })).toBeInTheDocument();
  });

  it('ServicePrincipalCreateDialog — surfaces a generic create error IN-dialog with requestId + keeps it open', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'server exploded',
      statusCode: 500,
      body: { message: 'server exploded', requestId: 'req_sp_err' },
    });
    renderDialog({
      client: makeMockClient({ createUser: vi.fn().mockRejectedValue(err) }),
    });
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('tab', { name: /services/i }));
    await user.click(screen.getByRole('button', { name: /create service principal/i }));

    const subDialog = await screen.findByRole('dialog', { name: /create service principal/i });
    await user.type(within(subDialog).getByLabelText(/^external id$/i), 'whatever');
    await user.click(within(subDialog).getByRole('button', { name: /^create$/i }));

    // Error announced inside the still-open sub-dialog with the requestId.
    const stillOpen = await screen.findByRole('dialog', { name: /create service principal/i });
    const alert = within(stillOpen).getByRole('alert');
    expect(alert).toHaveTextContent(/Could not create service principal\..*server exploded/i);
    expect(alert).toHaveTextContent(/req_sp_err/);
  });

  it('ServicePrincipalCreateDialog — a 409 externalId collision shows the specific DOMAIN message', async () => {
    const user = userEvent.setup();
    const conflict = new VectrosError({
      message: 'conflict',
      statusCode: 409,
      body: { message: 'externalId already exists', requestId: 'req_sp_409' },
    });
    renderDialog({
      client: makeMockClient({ createUser: vi.fn().mockRejectedValue(conflict) }),
    });
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('tab', { name: /services/i }));
    await user.click(screen.getByRole('button', { name: /create service principal/i }));

    const subDialog = await screen.findByRole('dialog', { name: /create service principal/i });
    await user.type(within(subDialog).getByLabelText(/^external id$/i), 'dup-bot');
    await user.click(within(subDialog).getByRole('button', { name: /^create$/i }));

    // Specific, actionable conflict message — NOT the generic createError.
    expect(
      await screen.findByText(/already exists.*Pick a different external ID/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Could not create service principal\./i)).not.toBeInTheDocument();
  });

  it('ServicePrincipalCreateDialog — submit is disabled while the create is in flight', async () => {
    const user = userEvent.setup();
    const createUser = vi.fn(() => new Promise(() => undefined)); // never resolves
    renderDialog({ client: makeMockClient({ createUser }) });
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('tab', { name: /services/i }));
    await user.click(screen.getByRole('button', { name: /create service principal/i }));

    const subDialog = await screen.findByRole('dialog', { name: /create service principal/i });
    await user.type(within(subDialog).getByLabelText(/^external id$/i), 'slow-bot');
    const createBtn = within(subDialog).getByRole('button', { name: /^create$/i });
    await user.click(createBtn);

    // While pending the SubmitButton disables, sets aria-busy, and swaps to
    // the "Creating…" label. Assert the in-flight disabled state.
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: /create service principal/i }))
          .getByRole('button', { name: /creating/i }),
      ).toBeDisabled(),
    );
  });

  // ----- ContextStep ----------------------------------

  it('ContextStep — context dropdown lists available contexts', async () => {
    const user = userEvent.setup();
    renderDialog();
    await advancePastBind(user);

    // Open the Select via its combobox role.
    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText(/^partner-api/)).toBeInTheDocument();
    expect(within(listbox).getByText(/^data-eng/)).toBeInTheDocument();
  });

  it('ContextStep — never offers the reserved control-plane context, even if the API still returns it', async () => {
    const user = userEvent.setup();
    renderDialog();
    vi.mocked(useDeveloperApi).mockReturnValue({
      listAppContexts: vi.fn().mockResolvedValue(
        pageOf([{ contextId: 'vectros-admin', name: 'Vectros Admin' }, ...SAMPLE_CONTEXTS]),
      ),
      createAppContext: vi.fn(),
      deleteAppContext: vi.fn(),
      listScopedKeys: vi.fn(),
      revokeScopedKey: vi.fn(),
      getAdminLogs: vi.fn(),
    } as never);
    await advancePastBind(user);

    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    // The real, non-reserved contexts are still offered...
    expect(within(listbox).getByText(/^partner-api/)).toBeInTheDocument();
    // ...but the reserved control-plane context is never a pickable target: a
    // scoped key needs a data context, and the partner API rejects an
    // explicit mint pinned to the reserved context outright.
    expect(within(listbox).queryByText(/^vectros-admin/)).not.toBeInTheDocument();
  });

  it('ContextStep — Next is disabled until a context is picked + profile resolved', async () => {
    const user = userEvent.setup();
    renderDialog();
    await advancePastBind(user);

    // Just-arrived at context, no context picked yet.
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(/^partner-api/));

    // Existence check resolves to the SAMPLE_PROFILE → Next enables.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled(),
    );
  });

  it('ContextStep — selecting a context shows the AccessProfile-exists alert', async () => {
    const user = userEvent.setup();
    renderDialog();
    await advancePastBind(user);
    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(/^partner-api/));

    expect(
      await screen.findByText(/AccessProfile exists for this/i),
    ).toBeInTheDocument();
    // The existing-profile detail shows the resolved profile's roleId.
    expect(screen.getByText(/tmpl-owner/i)).toBeInTheDocument();
  });

  it('ContextStep — 404 from getAccessProfile shows "No AccessProfile yet" + Create button', async () => {
    const user = userEvent.setup();
    const notFound = new VectrosError({ message: 'not found', statusCode: 404 });
    renderDialog({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockRejectedValue(notFound),
      }),
    });
    await advancePastBind(user);
    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(/^partner-api/));

    expect(await screen.findByText(/no accessprofile yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create profile/i })).toBeInTheDocument();
    // Next stays disabled — profile doesn't exist.
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
  });

  it('ContextStep — non-404 error from getAccessProfile shows error alert', async () => {
    const user = userEvent.setup();
    const serverErr = new VectrosError({ message: 'boom', statusCode: 500 });
    renderDialog({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockRejectedValue(serverErr),
      }),
    });
    await advancePastBind(user);
    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(/^partner-api/));

    expect(
      await screen.findByText(/could not check accessprofile\..*boom/i),
    ).toBeInTheDocument();
  });

  it('InlineProfileCreateDialog — opens from the Create profile button when profile is missing', async () => {
    const user = userEvent.setup();
    const notFound = new VectrosError({ message: 'not found', statusCode: 404 });
    renderDialog({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockRejectedValue(notFound),
      }),
    });
    await advancePastBind(user);
    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(/^partner-api/));

    await user.click(await screen.findByRole('button', { name: /create profile/i }));
    expect(
      await screen.findByRole('dialog', { name: /create accessprofile/i }),
    ).toBeInTheDocument();
  });

  it('InlineProfileCreateDialog — submits createAccessProfile with the right body shape', async () => {
    const user = userEvent.setup();
    const notFound = new VectrosError({ message: 'not found', statusCode: 404 });
    const client = makeMockClient({
      getAccessProfile: vi.fn().mockRejectedValue(notFound),
    });
    renderDialog({ client });
    await advancePastBind(user);
    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(/^partner-api/));
    await user.click(await screen.findByRole('button', { name: /create profile/i }));

    const subDialog = await screen.findByRole('dialog', { name: /create accessprofile/i });

    // ScopeEditor starts with one empty clause; grant Read on Records via its
    // permission matrix to satisfy the validateClauses check.
    await user.click(within(subDialog).getByRole('checkbox', { name: /read records/i }));

    // Create button is now enabled (clause is valid).
    const createBtn = within(subDialog).getByRole('button', { name: /^create profile$/i });
    await waitFor(() => expect(createBtn).toBeEnabled());
    await user.click(createBtn);

    await waitFor(() => {
      expect(client.auth.createAccessProfile).toHaveBeenCalledWith({
        contextId: 'partner-api',
        body: {
          principalId: 'usr_u_alice',
          scopes: [
            { allowed_actions: ['records:r'], data_scope: {}, granted_capabilities: [] },
          ],
          status: 'active',
        },
      });
    });
  });

  it('InlineProfileCreateDialog — a create failure is announced IN-dialog with requestId + keeps it open', async () => {
    const user = userEvent.setup();
    const notFound = new VectrosError({ message: 'not found', statusCode: 404 });
    const createErr = new VectrosError({
      message: 'profile rejected',
      statusCode: 500,
      body: { message: 'profile rejected', requestId: 'req_profile_err' },
    });
    renderDialog({
      client: makeMockClient({
        getAccessProfile: vi.fn().mockRejectedValue(notFound),
        createAccessProfile: vi.fn().mockRejectedValue(createErr),
      }),
    });
    await advancePastBind(user);
    await user.click(screen.getByRole('combobox', { name: /^app context$/i }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(/^partner-api/));
    await user.click(await screen.findByRole('button', { name: /create profile/i }));

    const subDialog = await screen.findByRole('dialog', { name: /create accessprofile/i });
    await user.click(within(subDialog).getByRole('checkbox', { name: /read records/i }));
    const createBtn = within(subDialog).getByRole('button', { name: /^create profile$/i });
    await waitFor(() => expect(createBtn).toBeEnabled());
    await user.click(createBtn);

    // The dialog stays open with an announced error carrying the requestId.
    const stillOpen = await screen.findByRole('dialog', { name: /create accessprofile/i });
    // Scope to the ApiErrorAlert by its message text (ScopeEditor may render
    // its own role="alert" validation node, so query by content not role).
    const errorText = await within(stillOpen).findByText(
      /Could not create AccessProfile\..*profile rejected/i,
    );
    const alert = errorText.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert as HTMLElement).toHaveTextContent(/req_profile_err/);
  });

  // ----- ReviewStep ------------------------------------

  it('ReviewStep — renders all 4 summary rows with the wizard selections', async () => {
    const user = userEvent.setup();
    renderDialog({ initialEnv: 'test' });
    await advancePastBind(user);
    await advancePastContext(user);

    // The Review intro paragraph is the canonical "we're at review" signal.
    expect(screen.getByText(/Confirm the details below/i)).toBeInTheDocument();
    // Assert the row VALUES — the user's selections carried forward.
    // (Skipping row labels since "App context" also appears in the
    // stepper above — `getByText` would fail on the duplicate; we'd
    // need `getAllByText` to disambiguate. The values themselves are
    // the actual contract being pinned.)
    expect(screen.getByText('good-name')).toBeInTheDocument(); // key name
    expect(screen.getByText('u_alice')).toBeInTheDocument(); // user id
    expect(screen.getByText('partner-api')).toBeInTheDocument(); // contextId
  });

  // ----- Create-key mutation + ConfirmationStep --------

  it('clicking Create submits createScopedKey with the right body shape', async () => {
    const user = userEvent.setup();
    const { client, onSuccess } = renderDialog();
    await advancePastBind(user);
    await advancePastContext(user);
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // Post-MR-#8-Phase-7: the key is minted in a REAL tenant id. The wizard
    // maps the selected env to the matching membership's tenantId; with the
    // single seeded (test) membership it resolves to the active TEST_TENANT_ID.
    await waitFor(() => {
      expect(client.auth.createScopedKey).toHaveBeenCalledWith({
        keyName: 'good-name',
        tenantId: TEST_TENANT_ID,
        contextId: 'partner-api',
        userId: 'u_alice',
      });
    });
    // Parent's onSuccess prop is fired on a successful create so the
    // parent can refresh its keys list (wired in a later step).
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('mints a PER-CONTEXT bearer for the profile + key when a DATA context is picked (BUG-2)', async () => {
    const user = userEvent.setup();
    const { client } = renderDialog();
    await advancePastBind(user);
    // Pick the SECOND data context (not the default the other tests use) —
    // proves the bearer follows the actual selection, not just whichever
    // context happens to be picked first.
    await advancePastContext(user, /^data-eng/);
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // The mint carries the picked context...
    await waitFor(() =>
      expect(client.auth.createScopedKey).toHaveBeenCalledWith(
        expect.objectContaining({ contextId: 'data-eng' }),
      ),
    );
    // ...and — the BUG-2 fix — the profile read AND the key mint ride a bearer
    // minted for THAT context (the second vectrosApiClient arg). Reverting any
    // context-scoped call to vectrosApiClient(tenant) would drop this arg.
    expect(vectrosApiClient).toHaveBeenCalledWith(TEST_TENANT_ID, 'data-eng');
  });

  it('operates in the ENV-selected tenant, not the active tenant, when they differ', async () => {
    const user = userEvent.setup();
    const LIVE_TENANT = 'tnt_live_11111111';
    // Active tenant = test; a second (live) membership exists. The wizard's env
    // radio starts on 'live', so the whole flow must target the LIVE tenant.
    const memberships = [
      ...TEST_MEMBERSHIPS,
      {
        ...TEST_MEMBERSHIPS[0]!,
        tenantId: LIVE_TENANT,
        tenantName: 'Test Org (Live)',
        tenantKind: 'live' as const,
      },
    ];
    const client = makeMockClient();
    vi.mocked(vectrosApiClient).mockReturnValue(client as never);
    vi.mocked(useDeveloperApi).mockReturnValue({
      listAppContexts: vi.fn().mockResolvedValue(pageOf(SAMPLE_CONTEXTS)),
      createAppContext: vi.fn(),
      deleteAppContext: vi.fn(),
      listScopedKeys: vi.fn(),
      revokeScopedKey: vi.fn(),
      getAdminLogs: vi.fn(),
    } as never);
    render(
      <TestIntlProvider>
        <TestTenantProvider tenant={TEST_TENANT_ID} memberships={memberships}>
          <ScopedKeyCreateDialog open onClose={vi.fn()} initialEnv="live" />
        </TestTenantProvider>
      </TestIntlProvider>,
    );
    await advancePastBind(user);
    await advancePastContext(user, /^data-eng/);
    await user.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(client.auth.createScopedKey).toHaveBeenCalled());

    // Contexts are enumerated for the LIVE env...
    expect(vi.mocked(useDeveloperApi)).toHaveBeenCalledWith('live');
    // ...and the profile probe + key mint ride the LIVE tenant, never the active
    // TEST tenant — profile-check and mint can no longer diverge across tenants.
    expect(vectrosApiClient).toHaveBeenCalledWith(LIVE_TENANT, 'data-eng');
    expect(vectrosApiClient).not.toHaveBeenCalledWith(TEST_TENANT_ID, 'data-eng');
  });

  it('ConfirmationStep — fresh create shows the rawKey + copy button + cache warning', async () => {
    const user = userEvent.setup();
    renderDialog();
    await advancePastBind(user);
    await advancePastContext(user);
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // The fresh-create alert + the raw key value + the cache warning.
    expect(
      await screen.findByText(/Copy this key now — it won't be shown again/i),
    ).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_CREATED_KEY.rawKey)).toBeInTheDocument();
    expect(screen.getByText(/Rust authorizer's policy-cache window/i)).toBeInTheDocument();
    // Copy icon button is present + accessible.
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeInTheDocument();
  });

  it('ConfirmationStep — idempotent match shows the existing-key info without rawKey', async () => {
    const user = userEvent.setup();
    renderDialog({
      client: makeMockClient({
        createScopedKey: vi.fn().mockResolvedValue(SAMPLE_IDEMPOTENT_KEY),
      }),
    });
    await advancePastBind(user);
    await advancePastContext(user);
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/Key already exists/i)).toBeInTheDocument();
    expect(screen.getByText('ssk_test_existing')).toBeInTheDocument();
    // Cache warning NOT shown on the idempotent path — the partner
    // didn't get a new key, so there's nothing to wait for.
    expect(
      screen.queryByText(/Rust authorizer's policy-cache window/i),
    ).not.toBeInTheDocument();
    // No copy button — no rawKey to copy.
    expect(screen.queryByRole('button', { name: /^copy$/i })).not.toBeInTheDocument();
  });

  it('submit error stays on review step + shows the error alert', async () => {
    const user = userEvent.setup();
    // No `body` on this error — the generic title renders alone (no server
    // message to surface beneath it via extractErrorMessage).
    const err = new VectrosError({ message: 'backend boom', statusCode: 500 });
    renderDialog({
      client: makeMockClient({
        createScopedKey: vi.fn().mockRejectedValue(err),
      }),
    });
    await advancePastBind(user);
    await advancePastContext(user);
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(
      await screen.findByText(/Could not create scoped key\./i),
    ).toBeInTheDocument();
    // Still on review — the intro paragraph remains visible.
    expect(screen.getByText(/Confirm the details below/i)).toBeInTheDocument();
    // The Create button is back to its enabled "Create" label.
    expect(screen.getByRole('button', { name: /^create$/i })).toBeEnabled();
  });

  it('submit error surfaces the server-specific message beneath the generic title when the error carries a body (e.g. the 403 for a delegate-mint denial)', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'forbidden',
      statusCode: 403,
      body: {
        message: 'Minting a key bound to a different principal requires the delegate-mint capability.',
      },
    });
    renderDialog({
      client: makeMockClient({
        createScopedKey: vi.fn().mockRejectedValue(err),
      }),
    });
    await advancePastBind(user);
    await advancePastContext(user);
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/Could not create scoped key\./i)).toBeInTheDocument();
    expect(screen.getByText(/requires the delegate-mint capability/i)).toBeInTheDocument();
  });

  it('submit error is ANNOUNCED via role="alert" and carries the requestId', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'backend boom',
      statusCode: 500,
      body: { message: 'backend boom', requestId: 'req_create_err' },
    });
    renderDialog({
      client: makeMockClient({
        createScopedKey: vi.fn().mockRejectedValue(err),
      }),
    });
    await advancePastBind(user);
    await advancePastContext(user);
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // The deferred-transition contract: failure stays on review with an
    // announced error. ApiErrorAlert sets role="alert" + the requestId.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not create scoped key\..*backend boom/i);
    expect(alert).toHaveTextContent(/req_create_err/);
    // Confirmation step never rendered — still on review.
    expect(screen.queryByText(/Copy this key now/i)).not.toBeInTheDocument();
  });

  // ----- Full nav flow (now traverses ALL real steps) -------------------

  it('Next advances basics → bind → context → review (all real steps)', async () => {
    const user = userEvent.setup();
    renderDialog();
    await advancePastBind(user);
    // At context — real picker.
    expect(
      screen.getByRole('combobox', { name: /^app context$/i }),
    ).toBeInTheDocument();
    await advancePastContext(user);
    // At review — the intro paragraph.
    expect(screen.getByText(/Confirm the details below/i)).toBeInTheDocument();
  });

  it('confirmation step shows the Done button (no Cancel/Back/Next text buttons); Done calls onClose', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await advancePastBind(user);
    await advancePastContext(user);
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // Wait for confirmation to render.
    await screen.findByText(/Copy this key now/i);
    // The text-labeled wizard nav buttons are gone.
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^next$/i })).not.toBeInTheDocument();
    // (The Copy icon-button exists — that's an aria-labeled icon button,
    // not a wizard nav control.)

    await user.click(screen.getByRole('button', { name: /^done$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Back returns to the previous step', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/^key name$/i), 'good-name');
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('alice@example.com');

    await user.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByLabelText(/^key name$/i)).toBeInTheDocument();
  });

  it('Back is disabled on the first step', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDisabled();
  });
});
