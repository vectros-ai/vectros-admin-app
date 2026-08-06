// ---------------------------------------------------------------------------
// InviteMemberDialog tests.
//
// Pinning:
//   1. Loads roles on open + renders them in the dropdown.
//   2. Validates email format.
//   3. Submit calls auth.createInvite with the right payload + auto-filled
//      acceptUrl + 7-day TTL.
//   4. Successful invite triggers onSuccess.
//   5. 409 + body.error === 'email_already_associated' → inline message
//      explaining the shared-Cognito-pool placeholder.
//   6. Generic error → generic message.
//   7. sendEmail=false success surfaces the inviteToken + acceptLink.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import {
  expectContextBindingHolds,
  makeBindingTrackedClient,
} from '../../test/contextBinding';
import type { ContextBindingRecord } from '../../test/contextBinding';
import { AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { InviteMemberDialog } from './InviteMemberDialog';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    // Pin so the test sees our mocked client per-test via vi.mocked().
    vectrosApiClient: vi.fn(),
  };
});

function makeMockClient(overrides: {
  listRoles?: ReturnType<typeof vi.fn>;
  createInvite?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    auth: {
      listRoles:
        overrides.listRoles ??
        vi.fn().mockResolvedValue(
          pageOf([
            { roleId: 'tmpl-owner', name: 'Owner' },
            { roleId: 'tmpl-member', name: 'Org Member' },
          ]),
        ),
      createInvite:
        overrides.createInvite ??
        vi.fn().mockResolvedValue({
          userId: 'u_new123',
          inviteExpiresAt: '2026-06-05T00:00:00Z',
          emailSent: true,
        }),
    },
  };
}

function renderDialog(opts: {
  open?: boolean;
  client?: ReturnType<typeof makeMockClient>;
  onSuccess?: () => void;
  onClose?: () => void;
} = {}) {
  const client = opts.client ?? makeMockClient();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  const onSuccess = opts.onSuccess ?? vi.fn();
  const onClose = opts.onClose ?? vi.fn();
  const utils = render(
    <TestIntlProvider>
      <TestTenantProvider kind="live">
        <InviteMemberDialog
          open={opts.open ?? true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </TestTenantProvider>
    </TestIntlProvider>,
  );
  return { ...utils, client, onSuccess, onClose };
}

beforeEach(() => {
  // Stub origin so the auto-filled acceptUrl is deterministic.
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { origin: 'https://admin.test.example' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('InviteMemberDialog', () => {
  it('loads roles on open and renders them in the dropdown', async () => {
    const { client } = renderDialog();
    await waitFor(() => {
      expect(client.auth.listRoles).toHaveBeenCalledWith({
        contextId: 'default',
        limit: AUTH_PAGE_SIZE,
      });
    });

    // Open the Select dropdown. MUI's Select opens on click.
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /access profile role/i }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Owner')).toBeInTheDocument();
    expect(within(listbox).getByText('Org Member')).toBeInTheDocument();
  });

  it('disables submit until email and role are populated', async () => {
    renderDialog();
    await waitFor(() => {
      expect(
        screen.getByRole('combobox', { name: /access profile role/i }),
      ).toBeInTheDocument();
    });
    const submit = screen.getByRole('button', { name: /send invite/i });
    expect(submit).toBeDisabled();

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/email address/i),
      'newmember@example.com',
    );
    // Roles pre-selected the first one on load → submit should be enabled.
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it('rejects invalid email format', async () => {
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email address/i), 'not-an-email');
    expect(await screen.findByText(/please enter a valid email address/i)).toBeInTheDocument();
  });

  it('submits createInvite with the auto-filled acceptUrl + 7-day TTL', async () => {
    const { client, onSuccess } = renderDialog();
    await waitFor(() =>
      expect(client.auth.listRoles).toHaveBeenCalled(),
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/email address/i),
      'newmember@example.com',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send invite/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => expect(client.auth.createInvite).toHaveBeenCalled());

    expect(client.auth.createInvite).toHaveBeenCalledWith({
      email: 'newmember@example.com',
      contextId: 'default',
      accessProfile: { roleId: 'tmpl-owner' },
      ttlSeconds: 7 * 86400,
      sendEmail: true,
      acceptUrl: 'https://admin.test.example/accept',
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('shows the email-already-associated message on 409 with body.error', async () => {
    const conflict = new VectrosError({
      message: 'conflict',
      statusCode: 409,
      body: {
        error: 'email_already_associated',
        message: 'alice@example.com already has a Vectros identity',
      },
    });
    const { client } = renderDialog({
      client: makeMockClient({
        createInvite: vi.fn().mockRejectedValue(conflict),
      }),
    });

    await waitFor(() =>
      expect(client.auth.listRoles).toHaveBeenCalled(),
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/email address/i),
      'alice@example.com',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send invite/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/already a member of your organization/i),
      ).toBeInTheDocument();
    });
  });

  it('renders the generic error via ApiErrorAlert (announced + requestId)', async () => {
    const err = new VectrosError({
      message: 'Internal Server Error',
      statusCode: 500,
      body: { message: 'Internal Server Error', requestId: 'corr-inv-99' },
    });
    renderDialog({
      client: makeMockClient({
        createInvite: vi.fn().mockRejectedValue(err),
      }),
    });

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /access profile role/i })).toBeInTheDocument(),
    );
    await user.type(
      screen.getByLabelText(/email address/i),
      'someone@example.com',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send invite/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/could not send invitation\..*Internal Server Error/i);
      // ApiErrorAlert surfaces the requestId for support.
      expect(alert).toHaveTextContent(/reference id:\s*corr-inv-99/i);
    });
  });

  it('disables submit and shows a spinner while createInvite is pending', async () => {
    let resolveInvite: ((v: unknown) => void) | undefined;
    const createInvite = vi.fn(
      () => new Promise((res) => { resolveInvite = res; }),
    );
    renderDialog({ client: makeMockClient({ createInvite }) });

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /access profile role/i })).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/email address/i), 'pending@example.com');
    const submit = screen.getByRole('button', { name: /send invite/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    // SubmitButton: disabled + a progressbar spinner while in flight.
    await waitFor(() => expect(submit).toBeDisabled());
    expect(within(submit).getByRole('progressbar')).toBeInTheDocument();
    resolveInvite?.({ userId: 'u_x' });
  });

  it('announces a roles-load failure as a role="alert" (not a quiet helper)', async () => {
    const err = new VectrosError({
      message: 'roles down',
      statusCode: 500,
      body: { message: 'roles down', requestId: 'corr-roles-1' },
    });
    renderDialog({
      client: makeMockClient({ listRoles: vi.fn().mockRejectedValue(err) }),
    });

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/couldn't load the available roles/i);
      expect(alert).toHaveTextContent(/reference id:\s*corr-roles-1/i);
    });
  });

  it('surfaces the inviteToken + acceptLink when sendEmail=false', async () => {
    const successWithToken = {
      userId: 'u_new123',
      inviteToken: 'inv_test_token_abc',
      acceptLink: 'https://admin.test.example/accept?t=inv_test_token_abc',
    };
    const { client } = renderDialog({
      client: makeMockClient({
        createInvite: vi.fn().mockResolvedValue(successWithToken),
      }),
    });
    await waitFor(() =>
      expect(client.auth.listRoles).toHaveBeenCalled(),
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/email address/i),
      'manual@example.com',
    );
    // Expand Advanced + uncheck sendEmail.
    await user.click(screen.getByRole('button', { name: /advanced options/i }));
    const checkbox = await screen.findByRole('checkbox', { name: /send the invite email/i });
    await user.click(checkbox);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send invite/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Copy the accept link below/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole('link', {
        name: /https:\/\/admin\.test\.example\/accept\?t=inv_test_token_abc/i,
      }),
    ).toBeInTheDocument();

    // The raw token is rendered with an accessible label + a copy button
    // (the pristine-bar affordance, replacing the old plain "token:" text).
    expect(screen.getByLabelText(/raw invite token/i)).toHaveTextContent('inv_test_token_abc');
    expect(screen.getByRole('button', { name: /copy raw token/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy accept link/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Tenant guard — repeated here rather than relying on MembersPage
  // withholding the button, because this dialog is exported and a fork can
  // mount it directly.
  // -------------------------------------------------------------------------
  it('refuses to submit on a test tenant and explains why', async () => {
    const client = makeMockClient();
    vi.mocked(vectrosApiClient).mockReturnValue(client as never);
    render(
      <TestIntlProvider>
        <TestTenantProvider kind="test">
          <InviteMemberDialog open onClose={vi.fn()} onSuccess={vi.fn()} />
        </TestTenantProvider>
      </TestIntlProvider>,
    );

    expect(
      await screen.findByText(/invitations are always created in your live tenant/i),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email address/i), 'newmember@example.com');
    await waitFor(() => expect(client.auth.listRoles).toHaveBeenCalled());

    // Even with a complete, valid form the submit stays disabled.
    expect(screen.getByRole('button', { name: /send invite/i })).toBeDisabled();
    expect(client.auth.createInvite).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Context binding — see the long note in MembersPage.test.tsx. Both of this
  // dialog's calls are context-scoped, and the submit one is the whole invite
  // flow: a bearer/request mismatch here 403s the only path a partner has to
  // add a member.
  // -------------------------------------------------------------------------
  it('pins listRoles and createInvite to a bearer minted for the context they name', async () => {
    const user = userEvent.setup();
    const records: ContextBindingRecord[] = [];
    vi.mocked(vectrosApiClient).mockImplementation(
      makeBindingTrackedClient(() => makeMockClient(), records) as never,
    );

    render(
      <TestIntlProvider>
        <TestTenantProvider kind="live">
          <InviteMemberDialog open onClose={vi.fn()} onSuccess={vi.fn()} />
        </TestTenantProvider>
      </TestIntlProvider>,
    );

    await waitFor(() =>
      expect(records.some((r) => r.method === 'auth.listRoles')).toBe(true),
    );

    await user.type(screen.getByLabelText(/email address/i), 'newmember@example.com');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send invite/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() =>
      expect(records.some((r) => r.method === 'auth.createInvite')).toBe(true),
    );

    expectContextBindingHolds(records, ['auth.listRoles', 'auth.createInvite']);
  });
});
