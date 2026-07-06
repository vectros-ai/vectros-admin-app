// ---------------------------------------------------------------------------
// AcceptPage tests.
//
// Validates the four error states (no token / malformed / invalid-issuer /
// expired) and the happy-path signup flow including:
//   - Locked email field
//   - signUp called with metadata.invite_token = raw token
//   - CONFIRMATION_REQUIRED → navigate /confirm?email=&t=
//   - COMPLETE → navigate /login
//   - AuthError surfaces inline
//   - Client-side password mismatch guard
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

import { AuthProvider } from '../../auth';
import { AuthError } from '../../auth';
import type * as InviteTokenModule from '../../invitations/token';
import type { AuthProviderAdapter, SignUpResult } from '../../auth';
import type { InviteTokenDecodeResult } from '../../invitations/token';
import { AcceptPage } from './AcceptPage';
import { TestIntlProvider } from '../../test/intl';

// ---------------------------------------------------------------------------
// Mock the invite-token decoder.
//
// Post-MR-#7.99 the real decoder is async + does ES256 signature verification
// via jose against the platform's JWKS endpoint. That's exercised in
// `src/invitations/token.test.ts` with mocked jose.
//
// HERE we want AcceptPage tests to assert AcceptPage's logic given a
// specific decoder result, without engaging jose at all (jsdom has no real
// JWKS server). The mock below mimics the *structural* pre-MR-#7.99
// behavior of decodeInviteToken — enough for the existing tests' makeToken-
// driven token shapes to drive the AcceptPage through the right states.
// The 3 new variants (NOT_YET_VALID / INVALID_SIGNATURE / JWKS_UNAVAILABLE)
// get their own dedicated tests using mockResolvedValueOnce overrides.
// ---------------------------------------------------------------------------
vi.mock('../../invitations/token', async () => {
  const actual = await vi.importActual<typeof InviteTokenModule>('../../invitations/token');
  return {
    ...actual,
    decodeInviteToken: vi.fn(structuralMockDecode),
  };
});

/**
 * Mock decoder — structural-only (does NOT verify signatures or fetch JWKS).
 * Same shape as the pre-MR-#7.99 sync decoder, made async. The base64url
 * payload segment is decoded + claims spot-checked exactly like the old
 * implementation.
 */
async function structuralMockDecode(raw: string): Promise<InviteTokenDecodeResult> {
  if (!raw.startsWith('inv_')) return { kind: 'MALFORMED' };
  const jwt = raw.slice(4);
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return { kind: 'MALFORMED' };
  let body: Record<string, unknown>;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    body = JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return { kind: 'MALFORMED' };
  }
  if (body['iss'] !== 'vectros-invite' || body['aud'] !== 'vectros-invite-accept') {
    return { kind: 'INVALID_ISSUER' };
  }
  const email = body['email'];
  if (typeof email !== 'string' || email.length === 0) return { kind: 'MALFORMED' };
  const exp = body['exp'];
  if (typeof exp !== 'number') return { kind: 'MALFORMED' };
  if (exp * 1000 <= Date.now()) return { kind: 'EXPIRED' };
  return {
    kind: 'VALID',
    claims: {
      email,
      orgName: typeof body['orgName'] === 'string' ? body['orgName'] : null,
      inviterName: typeof body['inviterName'] === 'string' ? body['inviterName'] : null,
      expiresAt: new Date(exp * 1000),
      sub: typeof body['sub'] === 'string' && body['sub'].length > 0 ? body['sub'] : null,
    },
  };
}

function mockAdapter(overrides: Partial<AuthProviderAdapter> = {}): AuthProviderAdapter {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    signIn: vi.fn(),
    confirmSignIn: vi.fn(),
    signUp: vi
      .fn()
      .mockResolvedValue({ kind: 'CONFIRMATION_REQUIRED', method: 'CODE' } satisfies SignUpResult),
    confirmSignUp: vi.fn(),
    resendSignUpCode: vi.fn(),
    forgotPassword: vi.fn(),
    confirmForgotPassword: vi.fn(),
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

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeToken(overrides: Record<string, unknown> = {}, expSecondsFromNow = 3600): string {
  const payload: Record<string, unknown> = {
    iss: 'vectros-invite',
    aud: 'vectros-invite-accept',
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    email: 'invitee@example.com',
    ...overrides,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `inv_${header}.${body}.sig`;
}

function renderAccept(provider: AuthProviderAdapter, queryString = '') {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[`/accept${queryString}`]}>
        <AuthProvider provider={provider}>
          <Routes>
            <Route path="/accept" element={<AcceptPage />} />
            <Route path="/confirm" element={<ConfirmCaptured />} />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

// Helper route that exposes the search params it received — lets us assert
// the navigation target precisely.
function ConfirmCaptured(): React.JSX.Element {
  return (
    <div>
      <div>confirm page</div>
      <div data-testid="confirm-query">{window.location.search /* not used in jsdom */}</div>
    </div>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AcceptPage — error states', () => {
  it('shows error when ?t is missing', async () => {
    renderAccept(mockAdapter(), '');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Invitation problem' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/this link is invalid/i)).toBeInTheDocument();
  });

  it('shows error for a malformed token', async () => {
    renderAccept(mockAdapter(), '?t=not-a-token');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Invitation problem' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/this invitation link is not valid/i)).toBeInTheDocument();
  });

  it('shows error for invalid issuer/audience', async () => {
    const t = makeToken({ iss: 'attacker' });
    renderAccept(mockAdapter(), `?t=${encodeURIComponent(t)}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Invitation problem' }),
    ).toBeInTheDocument();
  });

  it('shows expired message for past exp', async () => {
    const t = makeToken({}, -60);
    renderAccept(mockAdapter(), `?t=${encodeURIComponent(t)}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Invitation problem' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/this invitation has expired/i)).toBeInTheDocument();
  });

  it('error states do not render the signup form', async () => {
    renderAccept(mockAdapter(), '');
    await screen.findByRole('heading', { name: 'Invitation problem' });
    expect(screen.queryByLabelText(/first name/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  // ---- New error variants for the JWKS-verified decoder ----

  it('shows NOT_YET_VALID error when token nbf is in the future', async () => {
    const { decodeInviteToken } = await import('../../invitations/token');
    vi.mocked(decodeInviteToken).mockResolvedValueOnce({ kind: 'NOT_YET_VALID' });
    renderAccept(mockAdapter(), '?t=irrelevant-because-mocked');
    await screen.findByRole('heading', { name: 'Invitation problem' });
    expect(screen.getByText(/not yet active/i)).toBeInTheDocument();
  });

  it('shows INVALID_SIGNATURE error for a tampered token', async () => {
    const { decodeInviteToken } = await import('../../invitations/token');
    vi.mocked(decodeInviteToken).mockResolvedValueOnce({ kind: 'INVALID_SIGNATURE' });
    renderAccept(mockAdapter(), '?t=irrelevant-because-mocked');
    await screen.findByRole('heading', { name: 'Invitation problem' });
    expect(screen.getByText(/could not verify this invitation/i)).toBeInTheDocument();
  });

  it('shows JWKS_UNAVAILABLE error when JWKS endpoint is unreachable', async () => {
    const { decodeInviteToken } = await import('../../invitations/token');
    vi.mocked(decodeInviteToken).mockResolvedValueOnce({ kind: 'JWKS_UNAVAILABLE' });
    renderAccept(mockAdapter(), '?t=irrelevant-because-mocked');
    await screen.findByRole('heading', { name: 'Invitation problem' });
    expect(screen.getByText(/try opening the link again/i)).toBeInTheDocument();
  });

  it('shows the "verifying" loading state while the decoder is in flight', async () => {
    // Make the decoder hang for this test — assertion fires before the
    // promise resolves, so we see the PENDING state.
    const { decodeInviteToken } = await import('../../invitations/token');
    let resolveDecoder: (v: InviteTokenDecodeResult) => void = () => undefined;
    vi.mocked(decodeInviteToken).mockReturnValueOnce(
      new Promise((res) => {
        resolveDecoder = res;
      }),
    );
    renderAccept(mockAdapter(), '?t=irrelevant');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Verifying invitation…' }),
    ).toBeInTheDocument();
    // Accessibility hardening: the verify state now carries a LABELED LoadingBlock (was
    // a silent text card) — a screen reader hears the labeled progressbar so
    // the in-flight verify is announced.
    const spinner = screen.getByRole('progressbar', { name: 'Verifying invitation…' });
    expect(spinner).toBeInTheDocument();
    // Let the test clean up by resolving the decoder.
    resolveDecoder({ kind: 'MALFORMED' });
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Verifying invitation…' }),
      ).not.toBeInTheDocument();
    });
  });
});

describe('AcceptPage — happy path form', () => {
  it('renders the signup form for a valid token', async () => {
    const t = makeToken({
      email: 'alice@example.com',
      orgName: 'Acme Inc.',
      inviterName: 'Bob Smith',
    });
    renderAccept(mockAdapter(), `?t=${encodeURIComponent(t)}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome!' })).toBeInTheDocument();
    expect(screen.getByText('Bob Smith invited you to join Acme Inc.')).toBeInTheDocument();
    // (Note: the role doesn't add a trailing period — Acme Inc.'s name
    // already ends with one; double-punctuation reads poorly.)
    expect(screen.getByLabelText(/email address/i)).toHaveValue('alice@example.com');
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/last name/i)).toBeInTheDocument();
  });

  it('locks the email field — readonly + disabled', async () => {
    const t = makeToken({ email: 'invitee@example.com' });
    renderAccept(mockAdapter(), `?t=${encodeURIComponent(t)}`);
    const emailField = await screen.findByLabelText(/email address/i);
    expect(emailField).toBeDisabled();
    expect(emailField).toHaveAttribute('aria-readonly', 'true');
    expect(emailField).toHaveAttribute('readonly');
  });

  it('falls back to generic subtitle when no display claims', async () => {
    const t = makeToken();
    renderAccept(mockAdapter(), `?t=${encodeURIComponent(t)}`);
    expect(
      await screen.findByText(/complete the form below to finish creating/i),
    ).toBeInTheDocument();
  });

  it('rejects mismatched passwords client-side without calling signUp', async () => {
    const user = userEvent.setup();
    const signUpSpy = vi.fn();
    const provider = mockAdapter({ signUp: signUpSpy });
    const t = makeToken();
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    await screen.findByRole('heading', { name: 'Welcome!' });
    await user.type(screen.getByLabelText(/first name/i), 'Alice');
    await user.type(screen.getByLabelText(/last name/i), 'Smith');
    await user.type(screen.getByLabelText(/^Password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm password/), 'Aa1!DIFFERENT');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    });
    expect(signUpSpy).not.toHaveBeenCalled();
  });

  it('calls signUp with metadata.invite_token = raw token from URL', async () => {
    const user = userEvent.setup();
    const signUpSpy = vi
      .fn()
      .mockResolvedValue({ kind: 'CONFIRMATION_REQUIRED', method: 'CODE' } satisfies SignUpResult);
    const provider = mockAdapter({ signUp: signUpSpy });
    const t = makeToken({ email: 'alice@example.com' });
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    await screen.findByRole('heading', { name: 'Welcome!' });
    await user.type(screen.getByLabelText(/first name/i), 'Alice');
    await user.type(screen.getByLabelText(/last name/i), 'Smith');
    await user.type(screen.getByLabelText(/^Password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm password/), 'Aa1!aaaa');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(signUpSpy).toHaveBeenCalledWith({
        email: 'alice@example.com',
        password: 'Aa1!aaaa',
        firstName: 'Alice',
        lastName: 'Smith',
        metadata: { invite_token: t },
      });
    });
  });

  it('navigates to /confirm on CONFIRMATION_REQUIRED', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signUp: vi.fn().mockResolvedValue({
        kind: 'CONFIRMATION_REQUIRED',
        method: 'CODE',
      } satisfies SignUpResult),
    });
    const t = makeToken({ email: 'alice@example.com' });
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    await screen.findByRole('heading', { name: 'Welcome!' });
    await user.type(screen.getByLabelText(/first name/i), 'Alice');
    await user.type(screen.getByLabelText(/last name/i), 'Smith');
    await user.type(screen.getByLabelText(/^Password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm password/), 'Aa1!aaaa');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByText('confirm page')).toBeInTheDocument();
    });
  });

  it('navigates to /login on COMPLETE', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signUp: vi.fn().mockResolvedValue({ kind: 'COMPLETE' } satisfies SignUpResult),
    });
    const t = makeToken();
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    await screen.findByRole('heading', { name: 'Welcome!' });
    await user.type(screen.getByLabelText(/first name/i), 'A');
    await user.type(screen.getByLabelText(/last name/i), 'B');
    await user.type(screen.getByLabelText(/^Password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm password/), 'Aa1!aaaa');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByText('login page')).toBeInTheDocument();
    });
  });

  it('surfaces AuthError inline (PASSWORD_POLICY_VIOLATION verbatim)', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      signUp: vi
        .fn()
        .mockRejectedValue(
          new AuthError('PASSWORD_POLICY_VIOLATION', 'Password must contain at least 1 number.'),
        ),
    });
    const t = makeToken();
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    await screen.findByRole('heading', { name: 'Welcome!' });
    await user.type(screen.getByLabelText(/first name/i), 'A');
    await user.type(screen.getByLabelText(/last name/i), 'B');
    await user.type(screen.getByLabelText(/^Password/), 'aaaaaaaa');
    await user.type(screen.getByLabelText(/^Confirm password/), 'aaaaaaaa');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByText('Password must contain at least 1 number.')).toBeInTheDocument();
    });
  });

  it('back-to-sign-in link navigates to /login', async () => {
    const user = userEvent.setup();
    const t = makeToken();
    renderAccept(mockAdapter(), `?t=${encodeURIComponent(t)}`);
    await screen.findByRole('heading', { name: 'Welcome!' });
    await user.click(screen.getByRole('link', { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByText('login page')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Existing-identity pivot (shared-Cognito-pool ambiguity). When the
// invitee is ALREADY signed in, AcceptPage doesn't show the signup form:
//   - signed in AS the invited email → AUTO-LINK (a signUp would 409).
//   - signed in as a DIFFERENT email → sign-out-and-retry guard.
// `getCurrentUser` drives useAuth().user, so we override it per case and wait
// for the post-load re-render.
// ---------------------------------------------------------------------------
describe('AcceptPage — existing-identity branches', () => {
  it('AUTO-LINK: signed in as the invited email → links + shows success', async () => {
    const user = userEvent.setup();
    const linkSpy = vi.fn().mockResolvedValue({
      tenantId: 'tnt-1',
      partnerUserId: 'pu-1',
      role: 'SUB_USER',
      alreadyActive: false,
    });
    const provider = mockAdapter({
      // Same email as the token (makeToken default: invitee@example.com),
      // case-insensitively — the page lower-cases both sides.
      getCurrentUser: vi.fn().mockResolvedValue({
        sub: 'sub-invitee',
        email: 'Invitee@Example.com',
        firstName: 'Ivy',
        lastName: 'Invitee',
      }),
      linkInvitation: linkSpy,
    });
    const t = makeToken({ email: 'invitee@example.com' });
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    // No signup form — the auto-link CTA instead.
    const cta = await screen.findByRole('button', { name: 'Add to my account' });
    expect(screen.queryByLabelText(/first name/i)).not.toBeInTheDocument();

    await user.click(cta);

    // Linked with the raw token from the URL, then the success card renders.
    await waitFor(() => {
      expect(linkSpy).toHaveBeenCalledWith(t);
    });
    expect(await screen.findByRole('heading', { name: 'Invitation accepted' })).toBeInTheDocument();
    expect(screen.getByText(/this workspace has been added to your account/i)).toBeInTheDocument();
  });

  it('AUTO-LINK: surfaces an error inline when linkInvitation rejects', async () => {
    const user = userEvent.setup();
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue({
        sub: 'sub-invitee',
        email: 'invitee@example.com',
        firstName: null,
        lastName: null,
      }),
      linkInvitation: vi
        .fn()
        .mockRejectedValue(new AuthError('UNKNOWN', 'Failed to link invitation: 400')),
    });
    const t = makeToken({ email: 'invitee@example.com' });
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    await user.click(await screen.findByRole('button', { name: 'Add to my account' }));

    // authErrorToMessage maps an UNKNOWN AuthError to the generic catalog
    // copy (it does NOT leak the internal "Failed to link invitation: 400"
    // diagnostic to the user — only PASSWORD_POLICY_VIOLATION is verbatim).
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i);
    });
    // Still on the link card (no success heading) so the user can retry.
    expect(screen.queryByRole('heading', { name: 'Invitation accepted' })).not.toBeInTheDocument();
  });

  it('WRONG-IDENTITY: signed in as a different email → sign-out card', async () => {
    const user = userEvent.setup();
    const signOutSpy = vi.fn().mockResolvedValue(undefined);
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue({
        sub: 'sub-other',
        email: 'someone.else@example.com',
        firstName: 'Otto',
        lastName: 'Other',
      }),
      signOut: signOutSpy,
    });
    const t = makeToken({ email: 'invitee@example.com' });
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    expect(
      await screen.findByRole('heading', { name: 'Switch accounts to continue' }),
    ).toBeInTheDocument();
    // Body names both identities so the user understands the mismatch.
    expect(screen.getByText(/this invitation is for invitee@example.com/i)).toBeInTheDocument();
    expect(screen.getByText(/you're signed in as someone\.else@example\.com/i)).toBeInTheDocument();
    // No auto-link CTA and no signup form on this branch.
    expect(screen.queryByRole('button', { name: 'Add to my account' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/first name/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(signOutSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('WRONG-IDENTITY: surfaces a sign-out FAILURE in a role="alert"', async () => {
    const user = userEvent.setup();
    // Previously the catch silently swallowed the failure (setSigningOut(false)
    // only) — the user got no feedback. The hardening pass surfaces it.
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue({
        sub: 'sub-other',
        email: 'someone.else@example.com',
        firstName: 'Otto',
        lastName: 'Other',
      }),
      signOut: vi.fn().mockRejectedValue(new AuthError('NETWORK_ERROR', 'offline')),
    });
    const t = makeToken({ email: 'invitee@example.com' });
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    const signOutBtn = await screen.findByRole('button', { name: 'Sign out' });
    await user.click(signOutBtn);

    // The error is shown IN the card, and the button is re-enabled so the user
    // can retry (rather than being stuck on a dead button).
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Accessibility hardening: every async CTA across the three sub-cards now uses the
// shared <SubmitButton> (disabled + labeled spinner + aria-busy while in
// flight). A revert to the hand-rolled Button would lose aria-busy + fail here.
// ---------------------------------------------------------------------------
describe('AcceptPage — submit pending state', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('signup: disables Create account + shows aria-busy while signUp is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<SignUpResult>();
    const provider = mockAdapter({ signUp: vi.fn().mockReturnValue(gate.promise) });
    const t = makeToken();
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    await screen.findByRole('heading', { name: 'Welcome!' });
    await user.type(screen.getByLabelText(/first name/i), 'A');
    await user.type(screen.getByLabelText(/last name/i), 'B');
    await user.type(screen.getByLabelText(/^Password/), 'Aa1!aaaa');
    await user.type(screen.getByLabelText(/^Confirm password/), 'Aa1!aaaa');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    const button = await screen.findByRole('button', { name: 'Creating account…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    gate.resolve({ kind: 'COMPLETE' });
    await waitFor(() => expect(provider.signUp).toHaveBeenCalledTimes(1));
  });

  it('auto-link: disables Add to my account + shows aria-busy while linkInvitation is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<{
      tenantId: string;
      partnerUserId: string;
      role: 'SUB_USER';
      alreadyActive: boolean;
    }>();
    const provider = mockAdapter({
      getCurrentUser: vi.fn().mockResolvedValue({
        sub: 'sub-invitee',
        email: 'invitee@example.com',
        firstName: 'Ivy',
        lastName: 'Invitee',
      }),
      linkInvitation: vi.fn().mockReturnValue(gate.promise),
    });
    const t = makeToken({ email: 'invitee@example.com' });
    renderAccept(provider, `?t=${encodeURIComponent(t)}`);

    await user.click(await screen.findByRole('button', { name: 'Add to my account' }));

    const button = await screen.findByRole('button', { name: 'Adding…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    gate.resolve({
      tenantId: 'tnt-1',
      partnerUserId: 'pu-1',
      role: 'SUB_USER',
      alreadyActive: false,
    });
    await waitFor(() => expect(provider.linkInvitation).toHaveBeenCalledTimes(1));
  });
});
