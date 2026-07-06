// ---------------------------------------------------------------------------
// AccountPage tests.
//
// Renders inside AuthProvider (mock adapter via makeMockAuthProvider) +
// TestIntlProvider (Intl + a fresh QueryClient) + MemoryRouter. Drives the MFA
// management card: not-enrolled → enroll dialog → verify → flips to Enabled;
// enrolled → disable confirm; load error.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import { AuthProvider } from '../../auth';
import type { AuthProviderAdapter, AuthUser } from '../../auth';
import { makeMockAuthProvider } from '../../test/mockAuthProvider';
import { TestIntlProvider } from '../../test/intl';
import { AccountPage } from './AccountPage';

const aliceUser: AuthUser = {
  sub: 'sub-alice-123',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
};

function renderAccount(overrides: Partial<AuthProviderAdapter> = {}) {
  const provider = makeMockAuthProvider({
    getCurrentUser: vi.fn().mockResolvedValue(aliceUser),
    ...overrides,
  });
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <AuthProvider provider={provider}>
          <AccountPage />
        </AuthProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { provider };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AccountPage', () => {
  it('renders the account recap from the signed-in user', async () => {
    renderAccount();
    expect(await screen.findByRole('heading', { level: 1, name: /account/i })).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('sub-alice-123')).toBeInTheDocument();
  });

  it('shows "Not enabled" + a Set-up CTA when no MFA is enrolled', async () => {
    renderAccount({ getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }) });
    expect(await screen.findByText('Not enabled')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /set up authenticator app/i }),
    ).toBeInTheDocument();
  });

  it('opens the enrollment dialog (QR + secret) on Set-up', async () => {
    const user = userEvent.setup();
    const setUpTotp = vi.fn().mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/Vectros%20Admin:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Vectros%20Admin',
    });
    renderAccount({
      getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
      setUpTotp,
    });
    await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));

    const dialog = await screen.findByRole('dialog');
    expect(setUpTotp).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByTitle('Authenticator setup QR code')).toBeInTheDocument();
    expect(within(dialog).getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
  });

  it('verifies the code, then flips the card to Enabled', async () => {
    const user = userEvent.setup();
    const verifyTotpSetup = vi.fn().mockResolvedValue(undefined);
    // First status read: not enrolled. After verify + invalidate: enrolled.
    const getMfaStatus = vi
      .fn()
      .mockResolvedValueOnce({ enabled: [], preferred: null })
      .mockResolvedValue({ enabled: ['TOTP'], preferred: 'TOTP' });
    renderAccount({ getMfaStatus, verifyTotpSetup });

    await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/6-digit code/i), '654321');
    await user.click(within(dialog).getByRole('button', { name: /verify & enable/i }));

    expect(verifyTotpSetup).toHaveBeenCalledWith('654321');
    // Card flips once ['mfaStatus'] is invalidated + refetched.
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
  });

  it('surfaces a verify error inline without closing the dialog', async () => {
    const user = userEvent.setup();
    const { AuthError } = await import('../../auth');
    const verifyTotpSetup = vi
      .fn()
      .mockRejectedValue(new AuthError('CODE_MISMATCH', 'wrong code'));
    renderAccount({
      getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
      verifyTotpSetup,
    });
    await user.click(await screen.findByRole('button', { name: /set up authenticator app/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/6-digit code/i), '000000');
    await user.click(within(dialog).getByRole('button', { name: /verify & enable/i }));

    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    });
    // Dialog stays open for retry.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows Enabled + Turn off when TOTP is active, and disables on confirm', async () => {
    const user = userEvent.setup();
    const disableTotp = vi.fn().mockResolvedValue(undefined);
    const getMfaStatus = vi
      .fn()
      .mockResolvedValueOnce({ enabled: ['TOTP'], preferred: 'TOTP' })
      .mockResolvedValue({ enabled: [], preferred: null });
    renderAccount({ getMfaStatus, disableTotp });

    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /turn off/i }));

    // Confirm dialog → confirm.
    const dialog = await screen.findByRole('dialog', { name: /turn off two-factor/i });
    await user.click(within(dialog).getByRole('button', { name: /turn off/i }));
    expect(disableTotp).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Not enabled')).toBeInTheDocument();
  });

  it('shows an error when the MFA status fails to load', async () => {
    renderAccount({ getMfaStatus: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't load your security settings/i);
  });

  it('surfaces the requestId on the MFA load error (ApiErrorAlert)', async () => {
    // An API-shaped error carries `body.requestId`; ApiErrorAlert must surface
    // it so a user can quote the reference when filing a support ticket.
    const apiError = Object.assign(new Error('500'), {
      statusCode: 500,
      body: { message: 'Internal Server Error', requestId: 'req-mfa-9f3a' },
    });
    renderAccount({ getMfaStatus: vi.fn().mockRejectedValue(apiError) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load your security settings/i);
    expect(alert).toHaveTextContent(/req-mfa-9f3a/);
  });

  it('renders the account recap as a dl/dt/dd description list (MetaList semantics)', async () => {
    renderAccount();
    await screen.findByText('alice@example.com');
    const definitions = Array.from(document.querySelectorAll('dd')).map((d) => d.textContent);
    expect(definitions).toContain('alice@example.com');
    expect(definitions).toContain('Alice Smith');
    expect(definitions).toContain('sub-alice-123');
    expect(document.querySelectorAll('dt').length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the disable-confirm dialog open with an in-dialog error when disableTotp fails', async () => {
    const user = userEvent.setup();
    const { AuthError } = await import('../../auth');
    const disableTotp = vi
      .fn()
      .mockRejectedValue(new AuthError('UNKNOWN', 'session expired'));
    renderAccount({
      getMfaStatus: vi.fn().mockResolvedValue({ enabled: ['TOTP'], preferred: 'TOTP' }),
      disableTotp,
    });

    await user.click(await screen.findByRole('button', { name: /turn off/i }));
    const dialog = await screen.findByRole('dialog', { name: /turn off two-factor/i });
    await user.click(within(dialog).getByRole('button', { name: /turn off/i }));

    // The failure is announced INSIDE the still-open dialog, never behind it.
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('dialog', { name: /turn off two-factor/i })).toBeInTheDocument();
    // A prior failure must not reappear on reopen: cancel resets the error.
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /turn off/i }));
    const reopened = await screen.findByRole('dialog', { name: /turn off two-factor/i });
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables the confirm button while disableTotp is in flight', async () => {
    const user = userEvent.setup();
    let resolveDisable: (() => void) | undefined;
    const disableTotp = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDisable = resolve;
        }),
    );
    renderAccount({
      getMfaStatus: vi.fn().mockResolvedValue({ enabled: ['TOTP'], preferred: 'TOTP' }),
      disableTotp,
    });

    await user.click(await screen.findByRole('button', { name: /turn off/i }));
    const dialog = await screen.findByRole('dialog', { name: /turn off two-factor/i });
    const confirm = within(dialog).getByRole('button', { name: /turn off/i });
    await user.click(confirm);

    // Mid-call: confirm button is disabled + busy (SubmitButton pending).
    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(confirm).toHaveAttribute('aria-busy', 'true');

    // Let the call finish so the test exits cleanly.
    resolveDisable?.();
  });
});
