// ---------------------------------------------------------------------------
// KeysPage tests.
//
// Pinning:
//   1. Loading spinner while listScopedKeys is in flight.
//   2. Renders the table after load with correct fields per row — scoped to the
//      active environment (only the active tenant's keys show).
//   3. Empty state when the account has no scoped keys at all.
//   4. Error alert on listScopedKeys failure.
//   5. "Create scoped key" opens the ScopedKeyCreateDialog wizard.
//   6. Revoke icon disabled for keys whose status !== 'active'.
//   7. Revoke flow — opens confirmation, confirming calls
//      `auth.revokeScopedKey({ keyId })` and refetches the list.
//   8. User type chip renders the right verb per userType (HUMAN / SERVICE).
//
// Environment scoping:
//   The developer API returns the account-wide list across BOTH environments;
//   the page filters the rendered rows to the TenantSwitcher's active environment
//   (Live/Test). These tests seed live + test keys and assert only the active
//   env's keys render, that switching the active tenant flips the visible set,
//   and that an active env with no keys (while the other has some) shows the
//   "no keys in this environment" empty state (not the account-empty prompt).
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DevApi from '../../api/developerApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { useCurrentTenant } from '../../auth';
import type { TenantId, TenantMembership } from '../../auth';
import { KeysPage } from './KeysPage';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DevApi>();
  return {
    ...actual,
    useDeveloperApi: vi.fn(),
  };
});

// Two environments: a Live tenant and a Test tenant. The active TenantSwitcher
// environment selects which of these keys render.
const LIVE_TENANT_ID: TenantId = 'tnt_live_001';
const KEYS_TEST_TENANT_ID: TenantId = 'tnt_test_001';

// Both memberships so the switcher can flip between environments.
const KEY_MEMBERSHIPS: ReadonlyArray<TenantMembership> = [
  {
    tenantId: LIVE_TENANT_ID,
    tenantName: 'Acme (Live)',
    tenantKind: 'live',
    role: 'OWNER',
    status: 'ACTIVE',
    partnerId: 'ptr_live_0001',
  },
  {
    tenantId: KEYS_TEST_TENANT_ID,
    tenantName: 'Acme (Test)',
    tenantKind: 'test',
    role: 'OWNER',
    status: 'ACTIVE',
    partnerId: 'ptr_test_0001',
  },
];

// alice + old live in the LIVE tenant; bot lives in the TEST tenant.
const SAMPLE_KEYS = [
  {
    keyId: 'ssk_alice',
    keyName: 'research-bot prod',
    tenantId: LIVE_TENANT_ID,
    contextId: 'vectros-admin',
    userId: 'u_alice',
    userType: 'HUMAN',
    status: 'active',
    keyType: 'scoped',
    accessProfileRef: 'tnt_live_001#vectros-admin#usr_u_alice',
    createdAt: '2026-05-29T10:00:00Z',
  },
  {
    keyId: 'ssk_bot',
    keyName: 'ci-runner test',
    tenantId: KEYS_TEST_TENANT_ID,
    contextId: 'vectros-admin',
    userId: 'u_bot',
    userType: 'SERVICE',
    status: 'active',
    keyType: 'scoped',
    accessProfileRef: 'tnt_test_001#vectros-admin#usr_u_bot',
    createdAt: '2026-05-20T08:00:00Z',
  },
  {
    keyId: 'ssk_old',
    keyName: 'expired-key',
    tenantId: LIVE_TENANT_ID,
    contextId: 'vectros-admin',
    userId: 'u_alice',
    userType: 'HUMAN',
    status: 'revoked',
    keyType: 'scoped',
    accessProfileRef: 'tnt_live_001#vectros-admin#usr_u_alice',
    createdAt: '2026-04-01T08:00:00Z',
    revokedAt: '2026-04-15T08:00:00Z',
  },
];

function makeMockDevApi(overrides: {
  listScopedKeys?: ReturnType<typeof vi.fn>;
  revokeScopedKey?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    // Developer API returns the array directly (unwrapped from the page envelope).
    listScopedKeys:
      overrides.listScopedKeys ?? vi.fn().mockResolvedValue(SAMPLE_KEYS),
    revokeScopedKey:
      overrides.revokeScopedKey ?? vi.fn().mockResolvedValue(undefined),
    // Other DeveloperApi methods the page subtree (ScopedKeyCreateDialog) may touch.
    listAppContexts: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    createAppContext: vi.fn(),
    deleteAppContext: vi.fn(),
    getAdminLogs: vi.fn(),
  };
}

// A tiny probe that drives the TenantSwitcher from within the provider — the
// real switcher lives in the app layout, so tests trigger the env flip through
// the same `setTenant` the switcher calls.
function TenantSwitchProbe({ to }: { to: TenantId }): React.JSX.Element {
  const { setTenant } = useCurrentTenant();
  return <button onClick={() => void setTenant(to)}>switch-env</button>;
}

function renderPage(
  opts: {
    devApi?: ReturnType<typeof makeMockDevApi>;
    // Active TenantSwitcher environment; defaults to the Live tenant.
    activeTenant?: TenantId;
    // Render an env-switch probe alongside the page (flip test).
    withSwitch?: boolean;
  } = {},
) {
  const devApi = opts.devApi ?? makeMockDevApi();
  vi.mocked(useDeveloperApi).mockReturnValue(devApi as never);
  // ScopedKeyCreateDialog (rendered by KeysPage) imports vectrosApiClient at
  // module load; stub it so the dialog can mount. Its context-scoped calls only
  // fire on later wizard steps the KeysPage tests don't reach.
  vi.mocked(vectrosApiClient).mockReturnValue({ auth: {}, identity: {} } as never);
  const utils = render(
    <TestIntlProvider>
      <MemoryRouter>
        <TestTenantProvider
          tenant={opts.activeTenant ?? LIVE_TENANT_ID}
          memberships={KEY_MEMBERSHIPS}
        >
          {opts.withSwitch && <TenantSwitchProbe to={KEYS_TEST_TENANT_ID} />}
          <KeysPage />
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { ...utils, devApi };
}

beforeEach(() => {
  // Stub navigator.clipboard for any future copy-to-clipboard surfaces.
  // Currently KeysPage doesn't copy; harmless no-op.
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('KeysPage', () => {
  it('shows a loading spinner while keys are being fetched', () => {
    const listScopedKeys = vi.fn(() => new Promise(() => undefined)); // never resolves
    renderPage({ devApi: makeMockDevApi({ listScopedKeys }) });
    expect(screen.getByLabelText(/loading scoped keys/i)).toBeInTheDocument();
  });

  it('renders the active-env keys table after load', async () => {
    // Active env = Live → only the Live tenant's keys render.
    renderPage();
    expect(await screen.findByText('research-bot prod')).toBeInTheDocument();
    expect(screen.getByText('expired-key')).toBeInTheDocument();
    // The Test-tenant key is filtered out.
    expect(screen.queryByText('ci-runner test')).not.toBeInTheDocument();
    // userId in monospace cell — u_alice (Live), never u_bot (Test).
    expect(screen.getAllByText('u_alice').length).toBeGreaterThan(0);
    expect(screen.queryByText('u_bot')).not.toBeInTheDocument();
    // tenantId column shows only the active env's tenant.
    expect(screen.getAllByText('tnt_live_001').length).toBeGreaterThan(0);
    expect(screen.queryByText('tnt_test_001')).not.toBeInTheDocument();
  });

  it('renders the account-empty state when listScopedKeys returns []', async () => {
    renderPage({
      devApi: makeMockDevApi({ listScopedKeys: vi.fn().mockResolvedValue([]) }),
    });
    await waitFor(() =>
      expect(screen.getByText(/No scoped keys yet/i)).toBeInTheDocument(),
    );
  });

  it('shows an error alert if listScopedKeys fails', async () => {
    const err = new VectrosError({ message: 'Backend unavailable', statusCode: 503 });
    renderPage({
      devApi: makeMockDevApi({ listScopedKeys: vi.fn().mockRejectedValue(err) }),
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Could not load scoped keys\..*Backend unavailable/i),
      ).toBeInTheDocument();
    });
  });

  it('clicking the Create button opens the ScopedKeyCreateDialog wizard', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('research-bot prod');

    // The button is enabled (a later step wired the dialog — an earlier step
    // had this rendered disabled with a "coming soon" tooltip).
    const createButton = screen.getByRole('button', { name: /create scoped key/i });
    expect(createButton).toBeEnabled();

    await user.click(createButton);
    expect(
      await screen.findByRole('dialog', { name: /create scoped key/i }),
    ).toBeInTheDocument();
  });

  it('disables the revoke icon on rows whose status is not active', async () => {
    renderPage();
    await screen.findByText('expired-key');
    const revokeButtons = screen.getAllByRole('button', { name: /^revoke$/i });
    // Active env = Live → 2 visible keys (research-bot prod active, expired-key
    // revoked). The revoked row's button is disabled.
    expect(revokeButtons).toHaveLength(2);
    expect(revokeButtons[0]).toBeEnabled();
    expect(revokeButtons[1]).toBeDisabled();
  });

  it('revoke flow — confirms then calls revokeScopedKey({ keyId }) and refreshes', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    await screen.findByText('research-bot prod');

    // Open the confirmation dialog for the first row (ssk_alice).
    const revokeButtons = screen.getAllByRole('button', { name: /^revoke$/i });
    await user.click(revokeButtons[0]!);

    const confirmDialog = await screen.findByRole('dialog');
    expect(confirmDialog).toHaveTextContent(/Revoke this scoped key\?/i);
    expect(confirmDialog).toHaveTextContent(/research-bot prod/i);

    // Click the confirmation Revoke button inside the dialog.
    await user.click(within(confirmDialog).getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => {
      expect(devApi.revokeScopedKey).toHaveBeenCalledWith('ssk_alice');
    });
    // List was re-fetched after revoke.
    expect(devApi.listScopedKeys).toHaveBeenCalledTimes(2);
  });

  it('renders the right user-type chip per row', async () => {
    // Active env = Live → both visible rows are HUMAN; the SERVICE key lives in
    // the Test env and is filtered out.
    renderPage();
    await screen.findByText('research-bot prod');
    expect(screen.getAllByText('Human').length).toBe(2);
    expect(screen.queryByText('Service')).not.toBeInTheDocument();
  });

  // --- Environment scoping -------------------------------------------

  describe('environment scoping', () => {
    it('shows only the Live tenant keys when the active env is Live', async () => {
      renderPage({ activeTenant: LIVE_TENANT_ID });
      expect(await screen.findByText('research-bot prod')).toBeInTheDocument();
      expect(screen.getByText('expired-key')).toBeInTheDocument();
      expect(screen.queryByText('ci-runner test')).not.toBeInTheDocument();
    });

    it('shows only the Test tenant keys when the active env is Test', async () => {
      renderPage({ activeTenant: KEYS_TEST_TENANT_ID });
      expect(await screen.findByText('ci-runner test')).toBeInTheDocument();
      // The SERVICE chip belongs to the Test-env key.
      expect(screen.getByText('Service')).toBeInTheDocument();
      // Live-env keys are filtered out.
      expect(screen.queryByText('research-bot prod')).not.toBeInTheDocument();
      expect(screen.queryByText('expired-key')).not.toBeInTheDocument();
    });

    it('flips the visible set when the active tenant switches', async () => {
      const user = userEvent.setup();
      renderPage({ activeTenant: LIVE_TENANT_ID, withSwitch: true });

      // Start on Live.
      expect(await screen.findByText('research-bot prod')).toBeInTheDocument();
      expect(screen.queryByText('ci-runner test')).not.toBeInTheDocument();

      // Switch to Test — the visible set flips without a new fetch bucket.
      await user.click(screen.getByRole('button', { name: /switch-env/i }));

      expect(await screen.findByText('ci-runner test')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByText('research-bot prod')).not.toBeInTheDocument(),
      );
    });

    it('shows the "no keys in this environment" state when the active env is empty but another has keys', async () => {
      // Account has keys (all Live), but the active env is Test → the env-empty
      // state, NOT the account-empty create prompt.
      const liveOnly = SAMPLE_KEYS.filter((k) => k.tenantId === LIVE_TENANT_ID);
      renderPage({
        activeTenant: KEYS_TEST_TENANT_ID,
        devApi: makeMockDevApi({
          listScopedKeys: vi.fn().mockResolvedValue(liveOnly),
        }),
      });
      await waitFor(() =>
        expect(
          screen.getByText(/No scoped keys in this environment/i),
        ).toBeInTheDocument(),
      );
      // Not the account-empty prompt.
      expect(screen.queryByText(/No scoped keys yet/i)).not.toBeInTheDocument();
      // And no key rows leak across environments.
      expect(screen.queryByText('research-bot prod')).not.toBeInTheDocument();
    });
  });

  // --- Hardening -----------------------------------------------------

  it('loading state uses the labeled LoadingBlock spinner (a11y)', () => {
    const listScopedKeys = vi.fn(() => new Promise(() => undefined)); // never resolves
    renderPage({ devApi: makeMockDevApi({ listScopedKeys }) });
    // The spinner carries an accessible name (LoadingBlock bakes aria-label
    // onto the CircularProgress) — never a bare unlabeled spinner.
    const block = screen.getByRole('progressbar', { name: /loading scoped keys/i });
    expect(block).toBeInTheDocument();
  });

  it('load error surfaces via ApiErrorAlert with role="alert" + the requestId', async () => {
    const err = new VectrosError({
      message: 'Backend unavailable',
      statusCode: 503,
      body: { message: 'Backend unavailable', requestId: 'req_load_123' },
    });
    renderPage({
      devApi: makeMockDevApi({ listScopedKeys: vi.fn().mockRejectedValue(err) }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load scoped keys\..*Backend unavailable/i);
    // The correlation id is surfaced for support.
    expect(alert).toHaveTextContent(/req_load_123/);
  });

  it('revoke failure keeps the ConfirmDialog OPEN with the error shown IN the dialog (requestId included)', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'revoke rejected',
      statusCode: 500,
      body: { message: 'revoke rejected', requestId: 'req_revoke_err' },
    });
    const { devApi } = renderPage({
      devApi: makeMockDevApi({
        revokeScopedKey: vi.fn().mockRejectedValue(err),
      }),
    });
    await screen.findByText('research-bot prod');

    const revokeButtons = screen.getAllByRole('button', { name: /^revoke$/i });
    await user.click(revokeButtons[0]!);

    const confirmDialog = await screen.findByRole('dialog');
    await user.click(within(confirmDialog).getByRole('button', { name: /^revoke$/i }));

    await waitFor(() =>
      expect(devApi.revokeScopedKey).toHaveBeenCalledWith('ssk_alice'),
    );

    // The dialog STAYS OPEN — the canonical "error behind the modal" bug is
    // fixed: the failure is announced (role="alert") INSIDE the still-open
    // dialog, carrying the requestId.
    const stillOpen = screen.getByRole('dialog');
    const inDialogAlert = within(stillOpen).getByRole('alert');
    expect(inDialogAlert).toHaveTextContent(/Could not revoke\..*revoke rejected/i);
    expect(inDialogAlert).toHaveTextContent(/req_revoke_err/);
    // The confirm title is still present (we did not close).
    expect(stillOpen).toHaveTextContent(/Revoke this scoped key\?/i);
  });

  it('revoke confirm button is disabled while the revoke is in flight', async () => {
    const user = userEvent.setup();
    // A revoke that never resolves — pins the pending/disabled state.
    const revokeScopedKey = vi.fn(() => new Promise(() => undefined));
    renderPage({ devApi: makeMockDevApi({ revokeScopedKey }) });
    await screen.findByText('research-bot prod');

    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    const confirmDialog = await screen.findByRole('dialog');
    const confirmBtn = within(confirmDialog).getByRole('button', { name: /^revoke$/i });
    await user.click(confirmBtn);

    // ConfirmDialog disables the confirm button while pending.
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: /^revoke$/i })).toBeDisabled(),
    );
  });

  it('reopening the revoke dialog after a failure does not show the stale error', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({ message: 'boom', statusCode: 500 });
    renderPage({
      devApi: makeMockDevApi({ revokeScopedKey: vi.fn().mockRejectedValue(err) }),
    });
    await screen.findByText('research-bot prod');

    // First open → fail → close.
    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));
    await within(dialog).findByRole('alert');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Reopen → the prior failure must NOT reappear (mutation reset on close).
    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});
