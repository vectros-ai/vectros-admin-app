// ---------------------------------------------------------------------------
// MembersPage tests.
//
// Pinning:
//   1. Loading spinner while listUsers is in flight.
//   2. Renders the members table after load with correct columns.
//   3. Empty state when no members.
//   4. Filters by type + status.
//   5. Invite button opens the InviteMemberDialog (we only assert that
//      the dialog appears; full invite-flow coverage is in
//      InviteMemberDialog.test.tsx).
//   6. Revoke button opens confirmation; confirming calls deleteUser
//      with `{ id }` and refreshes the list.
//   7. Error state on listUsers failure.
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
import { MembersPage } from './MembersPage';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

const SAMPLE_USERS = [
  { id: 'u_alice', email: 'alice@example.com', type: 'HUMAN', status: 'ACTIVE' },
  { id: 'u_bob', email: 'bob@example.com', type: 'HUMAN', status: 'PENDING' },
  { id: 'u_bot', email: null, externalId: 'research-bot', type: 'SERVICE', status: 'ACTIVE' },
];

function makeMockClient(overrides: {
  listUsers?: ReturnType<typeof vi.fn>;
  getAccessProfile?: ReturnType<typeof vi.fn>;
  deleteUser?: ReturnType<typeof vi.fn>;
  resendInvite?: ReturnType<typeof vi.fn>;
  listRoles?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    identity: {
      listUsers: overrides.listUsers ?? vi.fn().mockResolvedValue(pageOf(SAMPLE_USERS)),
      deleteUser: overrides.deleteUser ?? vi.fn().mockResolvedValue(undefined),
    },
    auth: {
      getAccessProfile:
        overrides.getAccessProfile ??
        vi.fn().mockImplementation(({ principalId }: { principalId: string }) =>
          Promise.resolve({
            principalId,
            roleId: 'tmpl-owner',
            status: 'active',
          }),
        ),
      resendInvite: overrides.resendInvite ?? vi.fn().mockResolvedValue(undefined),
      listRoles:
        overrides.listRoles ??
        vi.fn().mockResolvedValue(pageOf([{ roleId: 'tmpl-owner', name: 'Owner' }])),
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
          <MembersPage />
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { origin: 'https://admin.test.example' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('MembersPage', () => {
  it('shows a loading spinner while users are being fetched', () => {
    const listUsers = vi.fn(() => new Promise(() => undefined)); // never resolves
    renderPage({ client: makeMockClient({ listUsers }) });
    expect(screen.getByLabelText(/loading members/i)).toBeInTheDocument();
  });

  it('renders the members table after load', async () => {
    renderPage();
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    // SERVICE-type users without email fall back to externalId.
    expect(screen.getByText('research-bot')).toBeInTheDocument();
  });

  it('links the AccessProfile chip to the real profile editor route (not a 404)', async () => {
    // The chip must point at the live ProfileEditor route
    // (/access/contexts/<ctx>/profiles/<principalId>), NOT the old
    // /access-profiles?focus=... path that falls through to NotFoundPage.
    renderPage();
    const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;
    const chip = within(aliceRow).getByRole('link', { name: 'tmpl-owner' });
    expect(chip).toHaveAttribute(
      'href',
      '/access/contexts/vectros-admin/profiles/usr_u_alice',
    );
  });

  it('drains paginated listUsers across pages, threading the cursor', async () => {
    // identity.listUsers is cursor-paginated (SDK 0.23). A non-null nextCursor on
    // page 1 forces the drain to fetch page 2; both pages' members must land in
    // the table (the queryFn drains, not first-page-only).
    const listUsers = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'u_p1', email: 'page1@example.com', type: 'HUMAN', status: 'ACTIVE' }],
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'u_p2', email: 'page2@example.com', type: 'HUMAN', status: 'ACTIVE' }],
        nextCursor: null,
      });
    renderPage({ client: makeMockClient({ listUsers }) });

    // Both pages' members rendered → the drain concatenated them.
    expect(await screen.findByText('page1@example.com')).toBeInTheDocument();
    expect(screen.getByText('page2@example.com')).toBeInTheDocument();

    // Page 2 was fetched seeded from page 1's nextCursor (the drain followed it).
    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(listUsers).toHaveBeenNthCalledWith(2, expect.objectContaining({ startFrom: 'cursor-1' }));
  });

  it('renders the empty state when listUsers returns []', async () => {
    renderPage({ client: makeMockClient({ listUsers: vi.fn().mockResolvedValue(pageOf([])) }) });
    await waitFor(() =>
      expect(screen.getByText(/No members yet/i)).toBeInTheDocument(),
    );
  });

  it('shows an announced error alert (role="alert") if listUsers fails', async () => {
    const err = new VectrosError({ message: 'Backend unavailable', statusCode: 503 });
    renderPage({ client: makeMockClient({ listUsers: vi.fn().mockRejectedValue(err) }) });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load your members/i);
    });
  });

  it('surfaces the requestId reference on the load-error alert when present', async () => {
    const err = new VectrosError({
      message: 'Backend unavailable',
      statusCode: 503,
      body: { message: 'Backend unavailable', requestId: 'corr-load-42' },
    });
    renderPage({ client: makeMockClient({ listUsers: vi.fn().mockRejectedValue(err) }) });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/reference id:\s*corr-load-42/i);
    });
  });

  it('labels the loading spinner accessibly while users load', () => {
    const listUsers = vi.fn(() => new Promise(() => undefined)); // never resolves
    renderPage({ client: makeMockClient({ listUsers }) });
    // LoadingBlock exposes the spinner with an accessible label.
    expect(screen.getByLabelText('Loading members…')).toBeInTheDocument();
  });

  it('gives the refresh button an explicit aria-label (not just a tooltip)', async () => {
    renderPage();
    await screen.findByText('alice@example.com');
    expect(screen.getByRole('button', { name: /^refresh$/i })).toBeInTheDocument();
  });

  it('filters by type — clicking Service hides Human-only rows', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('alice@example.com');

    await user.click(screen.getByRole('button', { name: /^service$/i }));

    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('research-bot')).toBeInTheDocument(); // SERVICE user's externalId
  });

  it('filters by status — Pending shows only PENDING members', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('alice@example.com');

    await user.click(screen.getByRole('button', { name: /^pending$/i }));

    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it('opens the InviteMemberDialog when "Invite member" is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('alice@example.com');

    await user.click(screen.getByRole('button', { name: /invite member/i }));

    expect(await screen.findByRole('dialog', { name: /invite a new member/i })).toBeInTheDocument();
  });

  it('revoke flow — confirms then calls deleteUser with { id } and refreshes', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await screen.findByText('alice@example.com');

    // Click revoke icon on the first row (Alice). Use the accessible label.
    const revokeButtons = screen.getAllByRole('button', { name: /^revoke$/i });
    // First button is the row action; subsequent revokes exist on other rows.
    await user.click(revokeButtons[0]!);

    // Confirmation dialog opens with Alice's email.
    const confirmDialog = await screen.findByRole('dialog');
    expect(confirmDialog).toHaveTextContent(/Revoke alice@example.com\?/i);

    await user.click(within(confirmDialog).getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => {
      expect(client.identity.deleteUser).toHaveBeenCalledWith({ id: 'u_alice' });
    });
    // List was re-fetched after revoke.
    expect(client.identity.listUsers).toHaveBeenCalledTimes(2);
  });

  it('keeps the revoke dialog OPEN and shows the error IN-dialog when deleteUser rejects', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'nope',
      statusCode: 500,
      body: { message: 'nope', requestId: 'corr-revoke-7' },
    });
    const { client } = renderPage({
      client: makeMockClient({ deleteUser: vi.fn().mockRejectedValue(err) }),
    });
    await screen.findByText('alice@example.com');

    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    const confirmDialog = await screen.findByRole('dialog');
    await user.click(within(confirmDialog).getByRole('button', { name: /^revoke$/i }));

    // Error renders inside the still-open dialog as an announced alert,
    // carrying the requestId — never occluded behind the modal.
    await waitFor(() => {
      const alert = within(confirmDialog).getByRole('alert');
      expect(alert).toHaveTextContent(/couldn't revoke that member/i);
      expect(alert).toHaveTextContent(/reference id:\s*corr-revoke-7/i);
    });
    // Dialog is still mounted (not closed on error).
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(client.identity.deleteUser).toHaveBeenCalledTimes(1);
  });

  it('disables the confirm button while the revoke is in flight (pending)', async () => {
    const user = userEvent.setup();
    let resolveDelete: (() => void) | undefined;
    const deleteUser = vi.fn(
      () => new Promise<void>((res) => { resolveDelete = res; }),
    );
    renderPage({ client: makeMockClient({ deleteUser }) });
    await screen.findByText('alice@example.com');

    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    const confirmDialog = await screen.findByRole('dialog');
    const confirmBtn = within(confirmDialog).getByRole('button', { name: /^revoke$/i });
    await user.click(confirmBtn);

    // While pending the confirm button is disabled (SubmitButton pending).
    await waitFor(() => expect(confirmBtn).toBeDisabled());
    resolveDelete?.();
  });

  it('clears a prior revoke failure when the dialog is reopened (mutation reset on close)', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({ message: 'nope', statusCode: 500 });
    renderPage({
      client: makeMockClient({ deleteUser: vi.fn().mockRejectedValue(err) }),
    });
    await screen.findByText('alice@example.com');

    // Fail a revoke.
    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/couldn't revoke/i),
    );

    // Cancel, then reopen — the stale error must NOT reappear.
    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('distinguishes a 404 profile (No profile) from a non-404 profile error', async () => {
    // Alice → real 500, Bob → 404, bot → success.
    const getAccessProfile = vi.fn().mockImplementation(
      ({ principalId }: { principalId: string }) => {
        if (principalId === 'usr_u_alice') {
          return Promise.reject(new VectrosError({ message: 'boom', statusCode: 500 }));
        }
        if (principalId === 'usr_u_bob') {
          return Promise.reject(new VectrosError({ message: 'missing', statusCode: 404 }));
        }
        return Promise.resolve({ principalId, roleId: 'tmpl-owner', status: 'active' });
      },
    );
    renderPage({ client: makeMockClient({ getAccessProfile }) });

    const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;
    const bobRow = screen.getByText('bob@example.com').closest('tr')!;

    // Alice's 500 → a distinct "couldn't load" cell, NOT "—".
    await waitFor(() =>
      expect(within(aliceRow).getByText(/couldn't load/i)).toBeInTheDocument(),
    );
    // Bob's 404 → the "no profile" em-dash, NOT conflated with the error.
    expect(within(bobRow).getByText('—')).toBeInTheDocument();
    expect(within(bobRow).queryByText(/couldn't load/i)).not.toBeInTheDocument();
  });

  it('blocks resend with a specific message when the member has no bound role', async () => {
    const user = userEvent.setup();
    // Bob is PENDING (so the resend action shows) but has no profile (404).
    const getAccessProfile = vi.fn().mockImplementation(
      ({ principalId }: { principalId: string }) => {
        if (principalId === 'usr_u_bob') {
          return Promise.reject(new VectrosError({ message: 'missing', statusCode: 404 }));
        }
        return Promise.resolve({ principalId, roleId: 'tmpl-owner', status: 'active' });
      },
    );
    const resendInvite = vi.fn().mockResolvedValue(undefined);
    renderPage({ client: makeMockClient({ getAccessProfile, resendInvite }) });
    await screen.findByText('bob@example.com');
    // Let the profile query settle so the no-role state is known.
    await waitFor(() => expect(getAccessProfile).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /resend invite/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no access profile role bound/i);
    expect(resendInvite).not.toHaveBeenCalled();
  });
});

