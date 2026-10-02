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

import { __resetVectrosApiTokenCacheForTest } from '@vectros-ai/react';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import {
  expectContextBindingHolds,
  makeBindingTrackedClient,
} from '../../test/contextBinding';
import type { ContextBindingRecord } from '../../test/contextBinding';
import { registerScope } from '../../test/scopeToken';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DeveloperApi from '../../api/developerApi';
import { AuthProvider, CurrentTenantProvider } from '../../auth';
import type { TenantMembership } from '../../auth';
import { TestTenantProvider, TEST_MEMBERSHIPS, TEST_TENANT_ID } from '../../test/TestTenantProvider';
import { makeMockAuthProvider } from '../../test/mockAuthProvider';
import { MembersPage } from './MembersPage';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

// The new Transfer-ownership action goes through the owner-gated developer
// API (../../api/developerApi), not the partner SDK — mock the hook the
// dialog consumes so these page-level tests don't need a real bearer.
vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DeveloperApi>();
  return {
    ...actual,
    useDeveloperApi: vi.fn(),
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

function makeMockDeveloperApi(
  overrides: {
    transferOwnership?: ReturnType<typeof vi.fn>;
    listUserProfiles?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    transferOwnership:
      overrides.transferOwnership ??
      vi.fn().mockResolvedValue({ partnerId: 'ptr_1', ownerUserId: 'u_alice' }),
    // MembersPage calls this unconditionally (via useDeveloperApi())
    // whenever the session is an OWNER (the default seeded membership — see
    // TestTenantProvider). Defaults to an empty cross-context view so tests
    // that don't care about it aren't forced to reason about it; tests
    // exercising the cross-context column itself override with real data.
    listUserProfiles: overrides.listUserProfiles ?? vi.fn().mockResolvedValue(pageOf([])),
  };
}

function renderPage(opts: {
  client?: ReturnType<typeof makeMockClient>;
  devApi?: ReturnType<typeof makeMockDeveloperApi>;
  /** Override the seeded memberships — e.g. a SUB_USER role to prove the transfer action hides. */
  memberships?: ReadonlyArray<TenantMembership>;
} = {}) {
  const client = opts.client ?? makeMockClient();
  const devApi = opts.devApi ?? makeMockDeveloperApi();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  vi.mocked(useDeveloperApi).mockReturnValue(devApi as never);
  const utils = render(
    <TestIntlProvider>
      <MemoryRouter>
        <TestTenantProvider kind="live" {...(opts.memberships ? { memberships: opts.memberships } : {})}>
          <MembersPage />
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { ...utils, client, devApi };
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { origin: 'https://admin.test.example' },
  });
  // Default every test to a wildcard scope so the pre-existing tests, which
  // don't reason about Resend's client-side scope gate, keep seeing it
  // enabled. Tests exercising the gate itself override with a narrower
  // registerScope(...) call.
  registerScope(['*']);
});

afterEach(() => {
  vi.clearAllMocks();
  __resetVectrosApiTokenCacheForTest();
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

  // The OWNER default session now renders the cross-context chip list
  // (see the "cross-context profile view" describe block below) — these two
  // pin the still-unchanged single-default-context chip, which only a
  // SUB_USER session falls back to now (a SUB_USER can't reach the
  // OWNER-gated developer-API route the cross-context view needs).
  it('SUB_USER: links the AccessProfile chip to the real profile editor route (not a 404)', async () => {
    // The chip must point at the live ProfileEditor route
    // (/access/contexts/<ctx>/profiles/<principalId>), NOT the old
    // /access-profiles?focus=... path that falls through to NotFoundPage.
    renderPage({ memberships: [{ ...TEST_MEMBERSHIPS[0]!, role: 'SUB_USER' }] });
    const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;
    const chip = within(aliceRow).getByRole('link', { name: 'tmpl-owner' });
    expect(chip).toHaveAttribute(
      'href',
      '/access/contexts/default/profiles/usr_u_alice',
    );
  });

  it('SUB_USER: AccessProfile chip shows "N roles" for a multi-role profile, not the bare principalId', async () => {
    // roleId is absent for a 2+-role composition (0.41.0) — the chip's
    // `profile.roleId ?? profile.principalId` fallback previously showed
    // the raw principalId (a valid-looking but uninformative label) for
    // this shape instead of anything role-related.
    const getAccessProfile = vi.fn().mockImplementation(
      ({ principalId }: { principalId: string }) =>
        Promise.resolve({ principalId, roleIds: ['hr-admin', 'eng-member'], status: 'active' }),
    );
    renderPage({
      client: makeMockClient({ getAccessProfile }),
      memberships: [{ ...TEST_MEMBERSHIPS[0]!, role: 'SUB_USER' }],
    });
    const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;
    const chip = await within(aliceRow).findByRole('link', { name: /2 roles/i });
    expect(chip.textContent).toMatch(/hr-admin/);
    expect(chip.textContent).toMatch(/eng-member/);
    expect(chip.textContent).not.toBe('usr_u_alice');
  });

  it('shows the usr_<id> principal beneath each member\'s email and links the row into the detail page', async () => {
    renderPage();
    const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;
    expect(within(aliceRow).getByText('usr_u_alice')).toBeInTheDocument();
    const emailLink = within(aliceRow).getByRole('link', { name: 'alice@example.com' });
    expect(emailLink).toHaveAttribute('href', '/members/u_alice');
  });

  // ---------------------------------------------------------------------
  // The AccessProfile column stops implying a single-context 1:1
  // relationship for an OWNER session: it shows every context the
  // member holds a profile in, each linking to that context's editor.
  // ---------------------------------------------------------------------
  describe('cross-context profile view (OWNER)', () => {
    it('renders one chip per context the member holds a profile in, each linking to its editor', async () => {
      const listUserProfiles = vi.fn().mockResolvedValue(
        pageOf([
          { id: 'p1', contextId: 'default', principalId: 'usr_u_alice', roleId: 'tmpl-owner' },
          { id: 'p2', contextId: 'billing', principalId: 'usr_u_alice', roleId: 'tmpl-billing' },
        ]),
      );
      renderPage({ devApi: makeMockDeveloperApi({ listUserProfiles }) });
      const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;

      const defaultChip = await within(aliceRow).findByRole('link', { name: 'default' });
      expect(defaultChip).toHaveAttribute(
        'href',
        '/access/contexts/default/profiles/usr_u_alice',
      );
      const billingChip = within(aliceRow).getByRole('link', { name: 'billing' });
      expect(billingChip).toHaveAttribute(
        'href',
        '/access/contexts/billing/profiles/usr_u_alice',
      );
    });

    it('shows "No profile" when the member holds no profile in any context', async () => {
      const listUserProfiles = vi.fn().mockResolvedValue(pageOf([]));
      renderPage({ devApi: makeMockDeveloperApi({ listUserProfiles }) });
      const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;
      await waitFor(() => expect(within(aliceRow).getByText('—')).toBeInTheDocument());
    });

    it('shows a distinct "couldn\'t load" cell on a genuine failure, not "No profile"', async () => {
      const listUserProfiles = vi.fn().mockRejectedValue(new Error('boom'));
      renderPage({ devApi: makeMockDeveloperApi({ listUserProfiles }) });
      const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;
      await waitFor(() =>
        expect(within(aliceRow).getByText(/couldn't load/i)).toBeInTheDocument(),
      );
    });

    it('renders a profile in the reserved control-plane context as a non-clickable chip, not a dead link', async () => {
      // admin-app's browser bearer can never mint against vectros-admin (see
      // MembersPage's own header comment) — a link there would 404 every time.
      const listUserProfiles = vi.fn().mockResolvedValue(
        pageOf([
          { id: 'p1', contextId: 'vectros-admin', principalId: 'usr_u_alice', roleId: 'admin' },
        ]),
      );
      renderPage({ devApi: makeMockDeveloperApi({ listUserProfiles }) });
      const aliceRow = (await screen.findByText('alice@example.com')).closest('tr')!;
      await screen.findByText('alice@example.com');
      expect(
        within(aliceRow).queryByRole('link', { name: 'vectros-admin' }),
      ).not.toBeInTheDocument();
      expect(within(aliceRow).getByText('vectros-admin')).toBeInTheDocument();
    });

    it('SUB_USER never calls the OWNER-gated cross-context route', async () => {
      const listUserProfiles = vi.fn().mockResolvedValue(pageOf([]));
      renderPage({
        devApi: makeMockDeveloperApi({ listUserProfiles }),
        memberships: [{ ...TEST_MEMBERSHIPS[0]!, role: 'SUB_USER' }],
      });
      await screen.findByText('alice@example.com');
      // Give any stray async query a tick to have fired if it were going to.
      await waitFor(() => expect(screen.getAllByText('tmpl-owner').length).toBeGreaterThan(0));
      expect(listUserProfiles).not.toHaveBeenCalled();
    });

    it('the Refresh button re-fetches the cross-context view too, not just the member list', async () => {
      const user = userEvent.setup();
      const listUserProfiles = vi.fn().mockResolvedValue(pageOf([]));
      renderPage({ devApi: makeMockDeveloperApi({ listUserProfiles }) });
      await screen.findByText('alice@example.com');
      await waitFor(() => expect(listUserProfiles).toHaveBeenCalled());
      const callsBeforeRefresh = listUserProfiles.mock.calls.length;

      await user.click(screen.getByRole('button', { name: /^refresh$/i }));

      await waitFor(() =>
        expect(listUserProfiles.mock.calls.length).toBeGreaterThan(callsBeforeRefresh),
      );
    });
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

  it('surfaces the server-specific reason beneath the generic title on a 409 (0.40.0) — a 409 here is NOT always "last owner"', async () => {
    // 0.40.0: DELETE /v1/users/{id} 409s for the last-OWNER refusal, but the
    // SAME status (and the same backend error class) is also used for a
    // context-confined caller trying to delete a user who has access in
    // ANOTHER app context — status code alone can't tell them apart, so the
    // UI must show the server's actual message, not assume one specific
    // cause. This fixture uses the OTHER-CONTEXT wording on purpose to prove
    // the rendering doesn't hardcode a "last owner" claim.
    const user = userEvent.setup();
    const conflict = new VectrosError({
      message: 'conflict',
      statusCode: 409,
      body: {
        message:
          'Cannot delete: this user has access in other app contexts. Remove them from THIS context via DELETE /v1/app-contexts/{contextId}/profiles/{principalId} instead.',
        requestId: 'corr-owner-1',
      },
    });
    renderPage({
      client: makeMockClient({ deleteUser: vi.fn().mockRejectedValue(conflict) }),
    });
    await screen.findByText('alice@example.com');

    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    const confirmDialog = await screen.findByRole('dialog');
    await user.click(within(confirmDialog).getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => {
      const alert = within(confirmDialog).getByRole('alert');
      expect(alert).toHaveTextContent(/couldn't revoke that member/i);
      expect(alert).toHaveTextContent(/access in other app contexts/i);
      // Never invents a MORE specific claim than the server actually sent.
      expect(alert).not.toHaveTextContent(/only remaining owner/i);
      expect(alert).toHaveTextContent(/reference id:\s*corr-owner-1/i);
    });
  });

  it('shows only the generic title (no stray detail line) when the error carries no body message', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({ message: 'conflict', statusCode: 409 });
    renderPage({
      client: makeMockClient({ deleteUser: vi.fn().mockRejectedValue(err) }),
    });
    await screen.findByText('alice@example.com');

    await user.click(screen.getAllByRole('button', { name: /^revoke$/i })[0]!);
    const confirmDialog = await screen.findByRole('dialog');
    await user.click(within(confirmDialog).getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => {
      expect(within(confirmDialog).getByRole('alert')).toHaveTextContent(
        /couldn't revoke that member/i,
      );
    });
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

  it('SUB_USER: distinguishes a 404 profile (No profile) from a non-404 profile error', async () => {
    // Alice → real 500, Bob → 404, bot → success. SUB_USER — an OWNER session
    // renders this cell from the cross-context view instead (see below).
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
    renderPage({
      client: makeMockClient({ getAccessProfile }),
      memberships: [{ ...TEST_MEMBERSHIPS[0]!, role: 'SUB_USER' }],
    });

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
    // The default session is an OWNER, so resend's roleId now derives from
    // the cross-context view (listUserProfiles), not the disabled
    // single-context profileQueries — see MembersPage's own `enabled:
    // !isOwner` comment. Bob is PENDING (so the resend action shows) but
    // has no profile anywhere.
    const listUserProfiles = vi.fn().mockImplementation((id: string) =>
      Promise.resolve(
        pageOf(
          id === 'u_bob'
            ? []
            : [{ contextId: 'default', principalId: `usr_${id}`, roleId: 'tmpl-owner', status: 'active' }],
        ),
      ),
    );
    const resendInvite = vi.fn().mockResolvedValue(undefined);
    renderPage({
      client: makeMockClient({ resendInvite }),
      devApi: makeMockDeveloperApi({ listUserProfiles }),
    });
    await screen.findByText('bob@example.com');
    // Let the cross-context query settle so the no-role state is known.
    await waitFor(() => expect(listUserProfiles).toHaveBeenCalled());
    // Wait past the client-side scope gate's own async mint before
    // clicking, or the button is still disabled and the click is a no-op.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /resend invite/i })).toBeEnabled(),
    );

    await user.click(screen.getByRole('button', { name: /resend invite/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no access profile role bound/i);
    expect(resendInvite).not.toHaveBeenCalled();
  });

  it('blocks resend with a distinct message for a multi-role (roleIds) member — not "no role"', async () => {
    const user = userEvent.setup();
    // Bob's profile composes 2+ roles: roleId is absent (0.41.0), only
    // roleIds is present. Without the fix this reads as "no role bound",
    // which is false — the member genuinely has roles, just not one this
    // admin app can resend against yet.
    const listUserProfiles = vi.fn().mockImplementation((id: string) =>
      Promise.resolve(
        pageOf([
          id === 'u_bob'
            ? { contextId: 'default', principalId: `usr_${id}`, roleIds: ['hr-admin', 'eng-member'], status: 'active' }
            : { contextId: 'default', principalId: `usr_${id}`, roleId: 'tmpl-owner', status: 'active' },
        ]),
      ),
    );
    const resendInvite = vi.fn().mockResolvedValue(undefined);
    renderPage({
      client: makeMockClient({ resendInvite }),
      devApi: makeMockDeveloperApi({ listUserProfiles }),
    });
    await screen.findByText('bob@example.com');
    await waitFor(() => expect(listUserProfiles).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /resend invite/i })).toBeEnabled(),
    );

    await user.click(screen.getByRole('button', { name: /resend invite/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/composes multiple roles/i);
    expect(alert).not.toHaveTextContent(/no access profile role bound/i);
    expect(resendInvite).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Client-side scope gate. The backend's `/resend` route requires users:c +
  // users:r + users:u (all three — the `c` requirement is a deliberate,
  // retained rule, not something Resend happens not to need) — before this
  // the button rendered unconditionally and an under-scoped sub-user got a
  // bare 403 on click.
  //
  // Red-test verified (not just asserted): reverting MembersPage.tsx's
  // `canResendInvite = canPerformAction('users:cru')` to a hardcoded `true`
  // (the historical always-enabled bug) makes ONLY "disables…" below fail;
  // hardcoding it to `false` (a broken always-deny gate) makes ONLY the two
  // "enables…" tests below fail. The three together, not any one alone, pin
  // both failure directions — the ops-union correctness itself (combined vs.
  // split-entry grants) is covered exhaustively at its source of truth,
  // `canPerform`'s own suite in packages/react.
  // -------------------------------------------------------------------------
  it('disables Resend when the caller lacks users:r + users:u', async () => {
    // Same grant that gets a sub-user onto this page — create-only, no r/u.
    registerScope(['users:c']);
    const resendInvite = vi.fn().mockResolvedValue(undefined);
    renderPage({ client: makeMockClient({ resendInvite }) });
    await screen.findByText('bob@example.com');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /resend invite/i })).toBeDisabled(),
    );
    expect(resendInvite).not.toHaveBeenCalled();
  });

  it('enables Resend once the caller holds a combined users:cru grant', async () => {
    registerScope(['users:cru']);
    renderPage();
    await screen.findByText('bob@example.com');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /resend invite/i })).toBeEnabled(),
    );
  });

  it('enables Resend when users:c, users:r and users:u are granted as separate entries', async () => {
    // canPerform unions ops across every granted `users:*` entry, not just a
    // single combined one — this pins that a caller isn't missed just
    // because their profile authored the grant split across rows.
    registerScope(['users:c', 'users:r', 'users:u']);
    renderPage();
    await screen.findByText('bob@example.com');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /resend invite/i })).toBeEnabled(),
    );
  });

  // -------------------------------------------------------------------------
  // Client-side scope gate for Revoke. The backend's DELETE route requires
  // users:d — before this the button rendered unconditionally and an
  // under-scoped sub-user got a bare 403 on click. Same red-test discipline as
  // the Resend block above: disable-only and enable-only each pin one
  // direction of the gate.
  // -------------------------------------------------------------------------
  it('disables Revoke when the caller lacks users:d', async () => {
    // A grant that covers every other member action but deletion.
    registerScope(['users:c', 'users:r', 'users:u']);
    renderPage();
    await screen.findByText('alice@example.com');

    // (No trailing `deleteUser).not.toHaveBeenCalled()` — this never clicks
    // the button, so that would be vacuously true regardless of this guard.)
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^revoke$/i })[0]).toBeDisabled(),
    );
  });

  it('enables Revoke once the caller holds users:d', async () => {
    registerScope(['users:d']);
    renderPage();
    await screen.findByText('alice@example.com');

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^revoke$/i })[0]).toBeEnabled(),
    );
  });

  it('surfaces an error when the member listing exceeds the drain ceiling', async () => {
    // The drain now REFUSES a partial listing. That is only an improvement if
    // the surface says so — the contract changed for 14 callers with unit
    // coverage on the helper alone, so at least one caller has to prove the
    // throw reaches a user. A cursor that never goes null is the shape that
    // triggers it.
    const listUsers = vi.fn().mockResolvedValue({
      data: [{ id: 'u_x', email: 'x@example.com', type: 'HUMAN', status: 'ACTIVE' }],
      nextCursor: 'never-ends',
    });
    renderPage({ client: makeMockClient({ listUsers }) });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load your members/i),
    );
    // And crucially NOT a table quietly holding the first 50 pages.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Live and test tenants are provisioned identically and are interchangeable,
  // so invite/resend act on whichever tenant the caller's own credential (the
  // TenantSwitcher-driven bearer) is bound to — there is no longer a
  // client-side tenant gate here. Assert Invite is offered the same way on
  // both.
  // -------------------------------------------------------------------------
  it('offers Invite on a live tenant', async () => {
    renderPage();
    await screen.findByText('alice@example.com');
    expect(screen.getByRole('button', { name: /invite member/i })).toBeEnabled();
  });

  it('offers Invite on a test tenant too', async () => {
    vi.mocked(vectrosApiClient).mockReturnValue(makeMockClient() as never);
    render(
      <TestIntlProvider>
        <MemoryRouter>
          <TestTenantProvider kind="test">
            <MembersPage />
          </TestTenantProvider>
        </MemoryRouter>
      </TestIntlProvider>,
    );
    await screen.findByText('alice@example.com');
    expect(screen.getByRole('button', { name: /invite member/i })).toBeEnabled();
  });

  // -------------------------------------------------------------------------
  // Client-side scope gate for Invite. The create route requires users:c —
  // before this the button rendered regardless of scope, gated only on which
  // tenant was active (the tests above). Both guards compose: a live tenant
  // AND the permission are each necessary on their own.
  // -------------------------------------------------------------------------
  it('disables Invite when the caller lacks users:c', async () => {
    registerScope(['users:r', 'users:u', 'users:d']);
    renderPage();
    await screen.findByText('alice@example.com');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /invite member/i })).toBeDisabled(),
    );
  });

  it('enables Invite once the caller holds users:c', async () => {
    registerScope(['users:c']);
    renderPage();
    await screen.findByText('alice@example.com');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /invite member/i })).toBeEnabled(),
    );
  });

  it('resends on a test tenant, same as live', async () => {
    // Same backend fix as the Invite tests above: resend resolves the
    // caller's own bound tenant, so it now acts identically on Test.
    const user = userEvent.setup();
    const resendInvite = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vectrosApiClient).mockReturnValue(
      makeMockClient({ resendInvite }) as never,
    );
    const listUserProfiles = vi.fn().mockImplementation((id: string) =>
      Promise.resolve(
        pageOf([{ contextId: 'default', principalId: `usr_${id}`, roleId: 'tmpl-owner', status: 'active' }]),
      ),
    );
    vi.mocked(useDeveloperApi).mockReturnValue(makeMockDeveloperApi({ listUserProfiles }) as never);
    render(
      <TestIntlProvider>
        <MemoryRouter>
          <TestTenantProvider kind="test">
            <MembersPage />
          </TestTenantProvider>
        </MemoryRouter>
      </TestIntlProvider>,
    );
    await screen.findByText('bob@example.com');
    // Let the cross-context query settle so resend's roleId derivation sees it.
    await waitFor(() => expect(listUserProfiles).toHaveBeenCalled());
    // Wait past the client-side scope gate's own async mint before
    // clicking, or the button is still disabled and the click is a no-op.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /resend invite/i })).toBeEnabled(),
    );

    await user.click(screen.getByRole('button', { name: /resend invite/i }));

    await waitFor(() => expect(resendInvite).toHaveBeenCalledTimes(1));
  });

  // -------------------------------------------------------------------------
  // Context binding. Every test above stubs `vectrosApiClient` as a bare
  // `vi.fn()` that ignores its arguments, so it can only see request SHAPE —
  // it is structurally blind to whether the bearer those requests ride is
  // pinned to the context they name. That is exactly how this page shipped
  // with every context-scoped call 403ing against the real API: the requests
  // named the reserved control-plane context while the client was built with
  // no context at all (⇒ a `default`-pinned bearer).
  //
  // This case wires the argument-aware factory instead and asserts the pairing
  // itself, so a future edit that changes one side without the other fails
  // here rather than in staging.
  // -------------------------------------------------------------------------
  it('pins every context-scoped call to a bearer minted for that same context', async () => {
    // SUB_USER: an OWNER session's per-row profile lookup is disabled (see
    // MembersPage's own `enabled: !isOwner` comment) in favor of the
    // OWNER-gated developer-API cross-context route, which mints no
    // context-pinned bearer at all — there's nothing for THIS check to
    // verify on that path. The `getAccessProfile`/`resendInvite` calls this
    // test pins are still real and still context-bound for a SUB_USER.
    const user = userEvent.setup();
    const records: ContextBindingRecord[] = [];
    vi.mocked(vectrosApiClient).mockImplementation(
      makeBindingTrackedClient(() => makeMockClient(), records) as never,
    );
    vi.mocked(useDeveloperApi).mockReturnValue(makeMockDeveloperApi() as never);

    render(
      <TestIntlProvider>
        <MemoryRouter>
          <TestTenantProvider memberships={[{ ...TEST_MEMBERSHIPS[0]!, role: 'SUB_USER' }]}>
            <MembersPage />
          </TestTenantProvider>
        </MemoryRouter>
      </TestIntlProvider>,
    );

    // Mount fans out one getAccessProfile per member…
    await screen.findByText('bob@example.com');
    await waitFor(() =>
      expect(records.some((r) => r.method === 'auth.getAccessProfile')).toBe(true),
    );
    // Wait past the client-side scope gate's own async mint before
    // clicking, or the button is still disabled and the click is a no-op.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /resend invite/i })).toBeEnabled(),
    );

    // …and Resend (PENDING rows only) is the other context-scoped call.
    await user.click(screen.getByRole('button', { name: /resend invite/i }));
    await waitFor(() =>
      expect(records.some((r) => r.method === 'auth.resendInvite')).toBe(true),
    );

    // Name the METHODS, not a count: a scalar floor is satisfiable by the
    // wrong calls (add a member to SAMPLE_USERS and one extra profile lookup
    // covers for a resend that stopped naming its context).
    expectContextBindingHolds(records, ['auth.getAccessProfile', 'auth.resendInvite']);
  });
});

// ---------------------------------------------------------------------------
// The "Transfer ownership" per-row action + its dialog wiring. Full
// disclosure/typed-confirm coverage lives in TransferOwnershipDialog.test.tsx;
// these pin only MembersPage's own responsibilities: WHO gets offered the
// action, WHICH rows are eligible, and the success-banner handoff.
// ---------------------------------------------------------------------------
describe('MembersPage — transfer ownership action', () => {
  const TRANSFER_LABEL = /^transfer ownership$/i;

  it('offers Transfer ownership on an eligible row (OWNER caller, ACTIVE HUMAN target)', async () => {
    renderPage();
    await screen.findByText('alice@example.com');
    expect(screen.getByRole('button', { name: TRANSFER_LABEL })).toBeInTheDocument();
  });

  it('withholds Transfer ownership on a PENDING row (no externalSubject to hold ownership)', async () => {
    renderPage();
    await screen.findByText('bob@example.com');
    // Alice (ACTIVE) offers it; Bob (PENDING) must not.
    expect(screen.getAllByRole('button', { name: TRANSFER_LABEL })).toHaveLength(1);
  });

  it('withholds Transfer ownership on a SERVICE row (no Cognito session to sign in with)', async () => {
    renderPage();
    await screen.findByText('research-bot');
    expect(screen.getAllByRole('button', { name: TRANSFER_LABEL })).toHaveLength(1);
  });

  it('still offers Transfer ownership on an ACTIVE HUMAN row with no externalSubject (a legacy row) — not silently hidden as "this is me"', async () => {
    // A row with no externalSubject is NOT the same thing as "this is my
    // own row" (the caller's own session, when loaded, always has a real
    // sub). Hiding the action here would be a mistaken self-match; the
    // right behavior is to still offer it and let the backend's own "that
    // member has not signed in yet" 400 be the one that explains why, if
    // it comes to that.
    const client = makeMockClient({
      listUsers: vi.fn().mockResolvedValue(
        pageOf([
          { id: 'u_legacy', email: 'legacy@example.com', type: 'HUMAN', status: 'ACTIVE' },
        ]),
      ),
    });
    renderPage({ client });
    await screen.findByText('legacy@example.com');
    expect(screen.getByRole('button', { name: TRANSFER_LABEL })).toBeInTheDocument();
  });

  it('hides Transfer ownership entirely for a SUB_USER caller — only an OWNER can call the route', async () => {
    renderPage({
      memberships: [{ ...TEST_MEMBERSHIPS[0]!, role: 'SUB_USER' }],
    });
    await screen.findByText('alice@example.com');
    expect(screen.queryByRole('button', { name: TRANSFER_LABEL })).not.toBeInTheDocument();
  });

  it("hides Transfer ownership on the caller's own row", async () => {
    // A custom auth tree (TestTenantProvider has no getCurrentUser override)
    // whose session's `sub` matches Alice's externalSubject.
    const client = makeMockClient({
      listUsers: vi.fn().mockResolvedValue(
        pageOf([
          { id: 'u_alice', email: 'alice@example.com', type: 'HUMAN', status: 'ACTIVE', externalSubject: 'sub-alice' },
          { id: 'u_carol', email: 'carol@example.com', type: 'HUMAN', status: 'ACTIVE', externalSubject: 'sub-carol' },
        ]),
      ),
    });
    vi.mocked(vectrosApiClient).mockReturnValue(client as never);
    vi.mocked(useDeveloperApi).mockReturnValue(makeMockDeveloperApi() as never);
    const adapter = makeMockAuthProvider({
      getCurrentUser: vi.fn().mockResolvedValue({
        sub: 'sub-alice',
        email: 'alice@example.com',
        firstName: null,
        lastName: null,
      }),
    });
    render(
      <TestIntlProvider>
        <MemoryRouter>
          <AuthProvider provider={adapter}>
            <CurrentTenantProvider
              tenancyProvider={adapter}
              initialTenant={TEST_TENANT_ID}
              initialMemberships={TEST_MEMBERSHIPS}
            >
              <MembersPage />
            </CurrentTenantProvider>
          </AuthProvider>
        </MemoryRouter>
      </TestIntlProvider>,
    );

    await screen.findByText('carol@example.com');
    // Carol (not the caller) is offered; Alice (the caller) is not.
    expect(screen.getAllByRole('button', { name: TRANSFER_LABEL })).toHaveLength(1);
  });

  it('clicking Transfer ownership opens TransferOwnershipDialog for that member', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('alice@example.com');

    await user.click(screen.getByRole('button', { name: TRANSFER_LABEL }));

    const dialog = await screen.findByRole('dialog', { name: /transfer ownership to/i });
    expect(dialog).toHaveTextContent('alice@example.com');
  });

  it('a successful transfer shows the success banner, closes the dialog, and refetches the list', async () => {
    const user = userEvent.setup();
    const transferOwnership = vi
      .fn()
      .mockResolvedValue({ partnerId: 'ptr_1', ownerUserId: 'u_alice' });
    const { client } = renderPage({ devApi: makeMockDeveloperApi({ transferOwnership }) });
    await screen.findByText('alice@example.com');

    await user.click(screen.getByRole('button', { name: TRANSFER_LABEL }));
    const dialog = await screen.findByRole('dialog', { name: /transfer ownership to/i });
    await user.type(within(dialog).getByLabelText(/confirm by email/i), 'alice@example.com');
    await user.click(within(dialog).getByRole('button', { name: /^transfer ownership$/i }));

    await waitFor(() => expect(transferOwnership).toHaveBeenCalledWith('u_alice'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(
      /ownership transferred to alice@example.com/i,
    );
    // The list was invalidated (best-effort refetch — see MembersPage's own
    // comment on why this session's own read may itself now 403).
    expect(client.identity.listUsers).toHaveBeenCalledTimes(2);
  });
});

