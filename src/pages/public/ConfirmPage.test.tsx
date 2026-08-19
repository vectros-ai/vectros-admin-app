// ---------------------------------------------------------------------------
// ConfirmPage tests.
//
// Validates:
//   - Missing ?email → error card (back-to-login link visible)
//   - Form submission calls confirmSignUp with trimmed code
//   - Success → navigate /login
//   - AuthError → inline error message (CODE_MISMATCH → friendly message)
//   - Resend button calls resendSignUpCode and shows success banner
//   - Resend error → inline error
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

import { AuthProvider } from '../../auth';
import { AuthError } from '../../auth';
import { makeMockAuthProvider as mockAdapter } from '../../test/mockAuthProvider';
import type { FullMockProvider } from '../../test/mockAuthProvider';
import { ConfirmPage } from './ConfirmPage';
import { TestIntlProvider } from '../../test/intl';

function renderConfirm(provider: FullMockProvider, queryString = '') {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[`/confirm${queryString}`]}>
        <AuthProvider provider={provider}>
          <Routes>
            <Route path="/confirm" element={<ConfirmPage />} />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ConfirmPage — missing email', () => {
  it('renders the "missing email" error card when ?email is absent', async () => {
    renderConfirm(mockAdapter(), '');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Confirmation problem' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/this link is missing an email/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/verification code/i)).not.toBeInTheDocument();
  });

  it('renders the error card when ?email is malformed', async () => {
    renderConfirm(mockAdapter(), '?email=notanemail');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Confirmation problem' }),
    ).toBeInTheDocument();
    // Bogus value is NOT echoed into a form — we bail to the error state.
    expect(screen.queryByLabelText(/verification code/i)).not.toBeInTheDocument();
  });

  it('still offers back-to-sign-in from the error card', async () => {
    const user = userEvent.setup();
    renderConfirm(mockAdapter(), '');
    await screen.findByRole('heading', { name: 'Confirmation problem' });
    await user.click(screen.getByRole('link', { name: 'Back to sign in' }));
    await waitFor(() => {
      expect(screen.getByText('login page')).toBeInTheDocument();
    });
  });
});

describe('ConfirmPage — confirm flow', () => {
  it('renders the form with email interpolated into the subtitle', async () => {
    renderConfirm(mockAdapter(), '?email=alice%40example.com');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Confirm your email' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Enter the verification code we sent to alice@example.com'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/verification code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('enables submit once code is typed', async () => {
    const user = userEvent.setup();
    renderConfirm(mockAdapter(), '?email=alice%40example.com');
    await user.type(screen.getByLabelText(/verification code/i), '123456');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('calls confirmSignUp with trimmed code, then navigates to /login', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.fn().mockResolvedValue(undefined);
    const provider = mockAdapter({ confirmSignUp: confirmSpy });
    renderConfirm(provider, '?email=alice%40example.com');

    await user.type(screen.getByLabelText(/verification code/i), '  123456  ');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith({
        email: 'alice@example.com',
        code: '123456',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('login page')).toBeInTheDocument();
    });
  });

  it('shows CODE_MISMATCH friendly message when confirmSignUp throws that code', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      confirmSignUp: vi.fn().mockRejectedValue(new AuthError('CODE_MISMATCH', 'native')),
    });
    renderConfirm(provider, '?email=alice%40example.com');

    await user.type(screen.getByLabelText(/verification code/i), '000000');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.getByText(/code you entered is incorrect/i)).toBeInTheDocument();
    });
    // Stays on the confirm page — no navigate.
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('shows EXPIRED_CODE message when confirmSignUp throws that code', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      confirmSignUp: vi.fn().mockRejectedValue(new AuthError('EXPIRED_CODE', 'native')),
    });
    renderConfirm(provider, '?email=alice%40example.com');

    await user.type(screen.getByLabelText(/verification code/i), '111111');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.getByText(/that code has expired/i)).toBeInTheDocument();
    });
  });
});

describe('ConfirmPage — resend flow', () => {
  it('calls resendSignUpCode with the email and shows a success banner', async () => {
    const user = userEvent.setup();
    const resendSpy = vi.fn().mockResolvedValue(undefined);
    const provider = mockAdapter({ resendSignUpCode: resendSpy });
    renderConfirm(provider, '?email=alice%40example.com');

    await user.click(screen.getByRole('button', { name: 'Resend code' }));

    await waitFor(() => {
      expect(resendSpy).toHaveBeenCalledWith({ email: 'alice@example.com' });
    });
    expect(await screen.findByText('A new code was sent to alice@example.com')).toBeInTheDocument();
  });

  it('clears prior error when resending', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      confirmSignUp: vi.fn().mockRejectedValue(new AuthError('CODE_MISMATCH', 'native')),
      resendSignUpCode: vi.fn().mockResolvedValue(undefined),
    });
    renderConfirm(provider, '?email=alice%40example.com');

    // Trigger the error first
    await user.type(screen.getByLabelText(/verification code/i), '000000');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/code you entered is incorrect/i);

    // Now resend — error should clear, success banner shows
    await user.click(screen.getByRole('button', { name: 'Resend code' }));
    await waitFor(() => {
      expect(screen.getByText('A new code was sent to alice@example.com')).toBeInTheDocument();
    });
    expect(screen.queryByText(/code you entered is incorrect/i)).not.toBeInTheDocument();
  });

  it('surfaces resend errors inline', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      resendSignUpCode: vi.fn().mockRejectedValue(new AuthError('LIMIT_EXCEEDED', 'native')),
    });
    renderConfirm(provider, '?email=alice%40example.com');

    await user.click(screen.getByRole('button', { name: 'Resend code' }));

    await waitFor(() => {
      expect(screen.getByText(/too many attempts/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Accessibility hardening:
//   - the Confirm submit is now the shared <SubmitButton> (disabled + spinner
//     + aria-busy while confirmSignUp is in flight).
//   - the resend link is hardened against a double-fire: the handler bails if a
//     resend (or a submit) is already in flight, AND the link is marked
//     aria-disabled/aria-busy while resending.
// ---------------------------------------------------------------------------
describe('ConfirmPage — hardening', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('confirm: disables the button + shows aria-busy while confirmSignUp is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const provider = mockAdapter({ confirmSignUp: vi.fn().mockReturnValue(gate.promise) });
    renderConfirm(provider, '?email=alice%40example.com');

    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    const button = await screen.findByRole('button', { name: 'Confirming…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    gate.resolve();
    await waitFor(() => expect(provider.confirmSignUp).toHaveBeenCalledTimes(1));
  });

  it('resend: a second click while resending does NOT fire a second request', async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    // First call hangs (in-flight); the guard must prevent a 2nd invocation.
    const resendSpy = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
    const provider = mockAdapter({ resendSignUpCode: resendSpy });
    renderConfirm(provider, '?email=alice%40example.com');

    const resend = screen.getByRole('button', { name: 'Resend code' });
    await user.click(resend);

    // While in flight the link is aria-disabled + aria-busy and shows "Sending…".
    const sending = await screen.findByRole('button', { name: 'Sending…' });
    expect(sending).toHaveAttribute('aria-disabled', 'true');
    expect(sending).toHaveAttribute('aria-busy', 'true');

    // A second click (fireEvent bypasses the disabled pointer guard) must be
    // swallowed by the in-handler guard — still exactly one request.
    await user.click(sending).catch(() => undefined);
    expect(resendSpy).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitFor(() =>
      expect(screen.getByText('A new code was sent to alice@example.com')).toBeInTheDocument(),
    );
  });
});
