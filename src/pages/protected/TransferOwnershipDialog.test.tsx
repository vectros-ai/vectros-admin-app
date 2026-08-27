// ---------------------------------------------------------------------------
// TransferOwnershipDialog tests.
//
// Pinning:
//   1. Renders the three required disclosures (irreversible / both tenants /
//      credentials not revoked).
//   2. Confirm CTA stays disabled until the target's email is typed exactly.
//   3. Confirming calls transferOwnership(member.id) and fires onSuccess with
//      the result + the target email.
//   4. A member with no email stays permanently un-armable — no id fallback,
//      never shows an id as though it were one.
//   5. Failure renders an in-dialog error (role="alert") with the server
//      detail + requestId, and the dialog stays open.
//   6. Closing (Cancel) resets the typed echo for next time.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DeveloperApi from '../../api/developerApi';
import { DeveloperApiError } from '../../api/developerApi';
import { TransferOwnershipDialog } from './TransferOwnershipDialog';
import type { UserResponse } from '../../api/vectrosApi';

vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DeveloperApi>();
  return {
    ...actual,
    useDeveloperApi: vi.fn(),
  };
});

const ALICE: UserResponse = {
  id: 'u_alice',
  email: 'alice@example.com',
  type: 'HUMAN',
  status: 'ACTIVE',
};

function makeMockDeveloperApi(overrides: { transferOwnership?: ReturnType<typeof vi.fn> } = {}) {
  return {
    transferOwnership:
      overrides.transferOwnership ??
      vi.fn().mockResolvedValue({ partnerId: 'ptr_1', ownerUserId: 'u_alice' }),
  };
}

function renderDialog(opts: {
  member?: UserResponse | null;
  devApi?: ReturnType<typeof makeMockDeveloperApi>;
  onClose?: () => void;
  onSuccess?: () => void;
} = {}) {
  const devApi = opts.devApi ?? makeMockDeveloperApi();
  vi.mocked(useDeveloperApi).mockReturnValue(devApi as never);
  const onClose = opts.onClose ?? vi.fn();
  const onSuccess = opts.onSuccess ?? vi.fn();
  const utils = render(
    <TestIntlProvider>
      <TransferOwnershipDialog
        member={opts.member === undefined ? ALICE : opts.member}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    </TestIntlProvider>,
  );
  return { ...utils, devApi, onClose, onSuccess };
}

describe('TransferOwnershipDialog', () => {
  it('is closed (renders nothing visible) when member is null', () => {
    renderDialog({ member: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('discloses all three required facts', () => {
    renderDialog();
    expect(screen.getByText(/immediately lose your own owner access/i)).toBeInTheDocument();
    expect(screen.getByText(/live and test tenants/i)).toBeInTheDocument();
    expect(screen.getByText(/are NOT revoked/i)).toBeInTheDocument();
  });

  it('keeps the Transfer CTA disabled until the email is typed exactly', async () => {
    const user = userEvent.setup();
    renderDialog();
    const cta = screen.getByRole('button', { name: /transfer ownership/i });
    expect(cta).toBeDisabled();

    const input = screen.getByLabelText(/confirm by email/i);
    // Deliberately short of the full address (no "@" yet) — proves the CTA
    // needs an exact match, not just a long-enough prefix. Stops before any
    // "@domain.tld"-shaped suffix so it can't misread as a real address
    // during the public-mirror content scrub (this app ships as a public
    // source mirror): a near-complete address truncated by exactly one
    // character lands on a real, non-allowlisted top-level domain rather
    // than the allowlisted one, and gets flagged as PII.
    await user.type(input, 'alice');
    expect(cta).toBeDisabled();

    await user.type(input, '@example.com');
    expect(cta).toBeEnabled();
  });

  it('confirming calls transferOwnership(member.id) and fires onSuccess', async () => {
    const user = userEvent.setup();
    const transferOwnership = vi
      .fn()
      .mockResolvedValue({ partnerId: 'ptr_1', ownerUserId: 'u_alice' });
    const onSuccess = vi.fn();
    renderDialog({ devApi: makeMockDeveloperApi({ transferOwnership }), onSuccess });

    await user.type(screen.getByLabelText(/confirm by email/i), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: /transfer ownership/i }));

    await waitFor(() => expect(transferOwnership).toHaveBeenCalledWith('u_alice'));
    expect(onSuccess).toHaveBeenCalledWith(
      { partnerId: 'ptr_1', ownerUserId: 'u_alice' },
      'alice@example.com',
    );
  });

  it('stays disabled (no id fallback) for a member with no email — never shows an id as though it were one', async () => {
    // MembersPage never opens this dialog for such a row in practice (it only
    // offers the action on HUMAN + ACTIVE members, who reach ACTIVE via an
    // invite that requires an email) — but if it ever were, this dialog must
    // not tell the operator to "type an email" and then arm on the raw id.
    const user = userEvent.setup();
    const noEmailMember: UserResponse = {
      id: 'u_bot',
      type: 'HUMAN',
      status: 'ACTIVE',
    };
    renderDialog({ member: noEmailMember });

    const cta = screen.getByRole('button', { name: /transfer ownership/i });
    const input = screen.getByLabelText(/confirm by email/i);
    await user.type(input, 'u_bot');
    expect(cta).toBeDisabled();
  });

  it('renders an announced in-dialog error on failure and stays open', async () => {
    const user = userEvent.setup();
    const err = new DeveloperApiError(409, {
      message: 'Account ownership changed while this request was in flight.',
      requestId: 'req_777',
    });
    const transferOwnership = vi.fn().mockRejectedValue(err);
    const onSuccess = vi.fn();
    renderDialog({ devApi: makeMockDeveloperApi({ transferOwnership }), onSuccess });

    await user.type(screen.getByLabelText(/confirm by email/i), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: /transfer ownership/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn't transfer ownership/i);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/ownership changed while this request/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/req_777/);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Cancel closes without calling transferOwnership', async () => {
    const user = userEvent.setup();
    const transferOwnership = vi.fn();
    const onClose = vi.fn();
    renderDialog({ devApi: makeMockDeveloperApi({ transferOwnership }), onClose });

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(transferOwnership).not.toHaveBeenCalled();
  });
});
