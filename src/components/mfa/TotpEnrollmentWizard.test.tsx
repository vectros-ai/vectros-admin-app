// ---------------------------------------------------------------------------
// TotpEnrollmentWizard tests.
//
// The wizard is presentational (props only — no auth context), so tests render
// it directly inside TestIntlProvider and drive the callbacks.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { TotpEnrollmentWizard } from '@vectros-ai/react';

const SECRET = 'ABCD1234EFGH5678';
const OTPAUTH = `otpauth://totp/Vectros%20Admin:me@example.com?secret=${SECRET}&issuer=Vectros%20Admin`;

function renderWizard(props: Partial<React.ComponentProps<typeof TotpEnrollmentWizard>> = {}) {
  const onVerify = props.onVerify ?? vi.fn();
  render(
    <TestIntlProvider>
      <TotpEnrollmentWizard secret={SECRET} otpauthUri={OTPAUTH} onVerify={onVerify} {...props} />
    </TestIntlProvider>,
  );
  return { onVerify };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('TotpEnrollmentWizard', () => {
  it('renders the QR code, manual secret, and instructions', () => {
    renderWizard();
    expect(screen.getByTitle('Authenticator setup QR code')).toBeInTheDocument();
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(screen.getByText(/scan this qr code with an authenticator app/i)).toBeInTheDocument();
  });

  it('disables Verify until a 6-digit code is entered', async () => {
    const user = userEvent.setup();
    renderWizard();
    const verify = screen.getByRole('button', { name: /verify & enable/i });
    expect(verify).toBeDisabled();

    await user.type(screen.getByLabelText(/6-digit code/i), '12345');
    expect(verify).toBeDisabled();

    await user.type(screen.getByLabelText(/6-digit code/i), '6');
    expect(verify).toBeEnabled();
  });

  it('strips non-digits and caps the code at 6 chars', async () => {
    const user = userEvent.setup();
    renderWizard();
    const field = screen.getByLabelText(/6-digit code/i) as HTMLInputElement;
    await user.type(field, '12ab34cd5678');
    expect(field.value).toBe('123456');
  });

  it('calls onVerify with the entered code on submit', async () => {
    const user = userEvent.setup();
    const { onVerify } = renderWizard();
    await user.type(screen.getByLabelText(/6-digit code/i), '246802');
    await user.click(screen.getByRole('button', { name: /verify & enable/i }));
    expect(onVerify).toHaveBeenCalledWith('246802');
  });

  it('copies the secret to the clipboard', async () => {
    // userEvent.setup() installs its own navigator.clipboard stub; assert via
    // its read-back rather than a hand-rolled writeText spy.
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('button', { name: /copy key/i }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(SECRET);
    });
  });

  it('shows the pending state and blocks submit while verifying', async () => {
    const onVerify = vi.fn();
    renderWizard({ onVerify, pending: true });
    expect(screen.getByText(/verifying/i)).toBeInTheDocument();
    // Verify button is disabled while pending even though a code may be present.
    expect(screen.getByRole('button', { name: /verifying/i })).toBeDisabled();
  });

  it('surfaces an error in an alert', () => {
    renderWizard({ error: 'That code was incorrect.' });
    expect(screen.getByRole('alert')).toHaveTextContent('That code was incorrect.');
  });

  it('renders Cancel only when onCancel is provided and invokes it', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderWizard({ onCancel });
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('has no Cancel button when onCancel is omitted', () => {
    renderWizard();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });
});
