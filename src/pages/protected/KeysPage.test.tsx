// ---------------------------------------------------------------------------
// KeysPage tests.
//
// Pinning:
//   1. Loading spinner while listScopedKeys is in flight.
//   2. Renders the table after load with correct fields per row.
//   3. Empty state when listScopedKeys returns [].
//   4. Error alert on listScopedKeys failure.
//   5. "Create scoped key" opens the ScopedKeyCreateDialog wizard.
//   6. Revoke icon disabled for keys whose status !== 'active'.
//   7. Revoke flow — opens confirmation, confirming calls
//      `auth.revokeScopedKey({ keyId })` and refetches the list.
//   8. User type chip renders the right verb per userType (HUMAN / SERVICE).
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { KeysPage } from './KeysPage';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

const SAMPLE_KEYS = [
  {
    keyId: 'ssk_alice',
    keyName: 'research-bot prod',
    tenantId: 'tnt_live_001',
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
    tenantId: 'tnt_test_001',
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
    tenantId: 'tnt_live_001',
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

function makeMockClient(overrides: {
  listScopedKeys?: ReturnType<typeof vi.fn>;
  revokeScopedKey?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    auth: {
      listScopedKeys:
        overrides.listScopedKeys ?? vi.fn().mockResolvedValue(pageOf(SAMPLE_KEYS)),
      revokeScopedKey:
        overrides.revokeScopedKey ?? vi.fn().mockResolvedValue(undefined),
    },
  };
}

function renderPage(opts: { client?: ReturnType<typeof makeMockClient> } = {}) {
  const client = opts.client ?? makeMockClient();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  const utils = render(
    <TestIntlProvider>
      <MemoryRouter>
        <TestTenantProvider>
          <KeysPage />
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { ...utils, client };
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
    renderPage({ client: makeMockClient({ listScopedKeys }) });
    expect(screen.getByLabelText(/loading scoped keys/i)).toBeInTheDocument();
  });

  it('renders the keys table after load', async () => {
    renderPage();
    expect(await screen.findByText('research-bot prod')).toBeInTheDocument();
    expect(screen.getByText('ci-runner test')).toBeInTheDocument();
    expect(screen.getByText('expired-key')).toBeInTheDocument();
    // userId in monospace cell.
    expect(screen.getAllByText('u_alice').length).toBeGreaterThan(0);
    expect(screen.getByText('u_bot')).toBeInTheDocument();
    // tenantId column.
    expect(screen.getAllByText('tnt_live_001').length).toBeGreaterThan(0);
    expect(screen.getByText('tnt_test_001')).toBeInTheDocument();
  });

  it('renders the empty state when listScopedKeys returns []', async () => {
    renderPage({
      client: makeMockClient({ listScopedKeys: vi.fn().mockResolvedValue(pageOf([])) }),
    });
    await waitFor(() =>
      expect(screen.getByText(/No scoped keys yet/i)).toBeInTheDocument(),
    );
  });

  it('shows an error alert if listScopedKeys fails', async () => {
    const err = new VectrosError({ message: 'Backend unavailable', statusCode: 503 });
    renderPage({
      client: makeMockClient({ listScopedKeys: vi.fn().mockRejectedValue(err) }),
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
    // 3 keys → 3 revoke buttons. The third row (expired-key) is revoked.
    expect(revokeButtons[2]).toBeDisabled();
    expect(revokeButtons[0]).toBeEnabled();
    expect(revokeButtons[1]).toBeEnabled();
  });

  it('revoke flow — confirms then calls revokeScopedKey({ keyId }) and refreshes', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
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
      expect(client.auth.revokeScopedKey).toHaveBeenCalledWith({ keyId: 'ssk_alice' });
    });
    // List was re-fetched after revoke.
    expect(client.auth.listScopedKeys).toHaveBeenCalledTimes(2);
  });

  it('renders the right user-type chip per row', async () => {
    renderPage();
    await screen.findByText('research-bot prod');
    // SAMPLE_KEYS has 2 HUMAN rows + 1 SERVICE row.
    expect(screen.getAllByText('Human').length).toBe(2);
    expect(screen.getAllByText('Service').length).toBe(1);
  });

  // --- Hardening -----------------------------------------------------

  it('loading state uses the labeled LoadingBlock spinner (a11y)', () => {
    const listScopedKeys = vi.fn(() => new Promise(() => undefined)); // never resolves
    renderPage({ client: makeMockClient({ listScopedKeys }) });
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
      client: makeMockClient({ listScopedKeys: vi.fn().mockRejectedValue(err) }),
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
    const { client } = renderPage({
      client: makeMockClient({
        revokeScopedKey: vi.fn().mockRejectedValue(err),
      }),
    });
    await screen.findByText('research-bot prod');

    const revokeButtons = screen.getAllByRole('button', { name: /^revoke$/i });
    await user.click(revokeButtons[0]!);

    const confirmDialog = await screen.findByRole('dialog');
    await user.click(within(confirmDialog).getByRole('button', { name: /^revoke$/i }));

    await waitFor(() =>
      expect(client.auth.revokeScopedKey).toHaveBeenCalledWith({ keyId: 'ssk_alice' }),
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
    renderPage({ client: makeMockClient({ revokeScopedKey }) });
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
      client: makeMockClient({ revokeScopedKey: vi.fn().mockRejectedValue(err) }),
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
