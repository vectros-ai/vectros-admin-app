import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

import { AuthProvider } from '../../auth';
import { AuthError } from '../../auth';
import type { AuthProviderAdapter } from '../../auth';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { TestIntlProvider } from '../../test/intl';

function mockAdapter(overrides: Partial<AuthProviderAdapter> = {}): AuthProviderAdapter {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    signIn: vi.fn(),
    confirmSignIn: vi.fn(),
    signUp: vi.fn(),
    confirmSignUp: vi.fn(),
    resendSignUpCode: vi.fn(),
    forgotPassword: vi.fn().mockResolvedValue(undefined),
    confirmForgotPassword: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn(),
    signOut: vi.fn(),
    getIdToken: vi.fn(),
    getMemberships: vi.fn().mockResolvedValue([]),
    getActiveTenant: vi.fn().mockResolvedValue(null),
    getActivePartnerUserId: vi.fn().mockResolvedValue(null),
    setActiveTenant: vi.fn().mockResolvedValue(undefined),
    checkUserExists: vi.fn().mockResolvedValue({ exists: false, isMe: false }),
    linkInvitation: vi
      .fn()
      .mockResolvedValue({
        tenantId: '',
        partnerUserId: '',
        role: 'SUB_USER',
        alreadyActive: false,
      }),
    getMfaStatus: vi.fn().mockResolvedValue({ enabled: [], preferred: null }),
    setUpTotp: vi
      .fn()
      .mockResolvedValue({
        secret: 'MOCKSECRET234567',
        otpauthUri: 'otpauth://totp/Mock:me?secret=MOCKSECRET234567&issuer=Mock',
      }),
    verifyTotpSetup: vi.fn().mockResolvedValue(undefined),
    disableTotp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderForgot(provider: AuthProviderAdapter) {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={['/forgot-password']}>
        <AuthProvider provider={provider}>
          <Routes>
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
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

describe('ForgotPasswordPage request stage', () => {
  it('renders the request form', () => {
    renderForgot(mockAdapter());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Reset your password' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
  });

  it('calls forgotPassword with trimmed email and transitions to reset stage', async () => {
    const user = userEvent.setup();
    const spy = vi.fn().mockResolvedValue(undefined);
    const provider = mockAdapter({ forgotPassword: spy });
    renderForgot(provider);
    await user.type(screen.getByLabelText(/email address/i), '  a@b.com  ');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ email: 'a@b.com' });
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose a new password' }),
    ).toBeInTheDocument();
  });

  it('shows error message when forgotPassword throws', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      forgotPassword: vi.fn().mockRejectedValue(new AuthError('LIMIT_EXCEEDED', 'x')),
    });
    renderForgot(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => {
      expect(screen.getByText(/too many attempts/i)).toBeInTheDocument();
    });
  });
});

describe('ForgotPasswordPage reset stage', () => {
  async function gotoResetStage(provider: AuthProviderAdapter) {
    const user = userEvent.setup();
    renderForgot(provider);
    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByRole('heading', { name: 'Choose a new password' });
    return user;
  }

  it('rejects mismatched passwords client-side without calling the adapter', async () => {
    const confirmSpy = vi.fn();
    const provider = mockAdapter({ confirmForgotPassword: confirmSpy });
    const user = await gotoResetStage(provider);

    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^New password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm new password/), 'Aa1!DIFFERENT');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('calls confirmForgotPassword and shows success on resolution', async () => {
    const confirmSpy = vi.fn().mockResolvedValue(undefined);
    const provider = mockAdapter({ confirmForgotPassword: confirmSpy });
    const user = await gotoResetStage(provider);

    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^New password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm new password/), 'Aa1!aaaa');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith({
        email: 'a@b.com',
        code: '123456',
        newPassword: 'Aa1!aaaa',
      });
    });
    expect(await screen.findByRole('heading', { name: 'Password reset' })).toBeInTheDocument();
  });

  it('shows CODE_MISMATCH error when confirmForgotPassword throws that code', async () => {
    const provider = mockAdapter({
      confirmForgotPassword: vi.fn().mockRejectedValue(new AuthError('CODE_MISMATCH', 'x')),
    });
    const user = await gotoResetStage(provider);

    await user.type(screen.getByLabelText(/verification code/i), '000000');
    await user.type(screen.getByLabelText(/^New password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm new password/), 'Aa1!aaaa');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(screen.getByText(/code you entered is incorrect/i)).toBeInTheDocument();
    });
  });

  it('surfaces PASSWORD_POLICY_VIOLATION provider message verbatim', async () => {
    const provider = mockAdapter({
      confirmForgotPassword: vi
        .fn()
        .mockRejectedValue(
          new AuthError('PASSWORD_POLICY_VIOLATION', 'Password must contain at least 1 number.'),
        ),
    });
    const user = await gotoResetStage(provider);

    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^New password/), 'aaaaaaaa');
    await user.type(screen.getByLabelText(/^Confirm new password/), 'aaaaaaaa');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(screen.getByText('Password must contain at least 1 number.')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Accessibility hardening: both stage submits are now the shared <SubmitButton>
// (disabled + labeled spinner + aria-busy while the adapter call is in flight).
// A revert to the hand-rolled Button would lose aria-busy and fail here.
// ---------------------------------------------------------------------------
describe('ForgotPasswordPage — submit pending state', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('request: disables Send code + shows aria-busy while forgotPassword is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const provider = mockAdapter({ forgotPassword: vi.fn().mockReturnValue(gate.promise) });
    renderForgot(provider);

    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    const button = await screen.findByRole('button', { name: 'Sending…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    gate.resolve();
    await waitFor(() => expect(provider.forgotPassword).toHaveBeenCalledTimes(1));
  });

  it('reset: disables Reset password + shows aria-busy while confirmForgotPassword is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const provider = mockAdapter({
      forgotPassword: vi.fn().mockResolvedValue(undefined),
      confirmForgotPassword: vi.fn().mockReturnValue(gate.promise),
    });
    renderForgot(provider);

    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByRole('heading', { name: 'Choose a new password' });

    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^New password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm new password/), 'Aa1!aaaa');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    const button = await screen.findByRole('button', { name: 'Resetting…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    gate.resolve();
    await waitFor(() => expect(provider.confirmForgotPassword).toHaveBeenCalledTimes(1));
  });
});

describe('ForgotPasswordPage success stage', () => {
  it('navigates back to /login from the success CTA', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter();
    renderForgot(provider);

    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByRole('heading', { name: 'Choose a new password' });
    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^New password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm new password/), 'Aa1!aaaa');
    await user.click(screen.getByRole('button', { name: 'Reset password' }));

    await screen.findByRole('heading', { name: 'Password reset' });
    await user.click(screen.getByRole('button', { name: 'Continue to sign in' }));

    await waitFor(() => {
      expect(screen.getByText('login page')).toBeInTheDocument();
    });
  });
});
