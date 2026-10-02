// ---------------------------------------------------------------------------
// IssuersPage tests.
//
// Pinning:
//   1. Renders title + subtitle up-front, no create button (view + edit only).
//   2. Loading spinner while listIssuers is in flight.
//   3. Error alert when listIssuers fails.
//   4. Empty state when listIssuers returns [].
//   5. Table renders one row per issuer, with a status chip.
//   6. Edit dialog opens prefilled with the issuer's current safe-field values
//      and its trust-anchor fields shown read-only.
//   7. Save calls updateIssuer with ONLY the safe fields — issuer/jwksUri/
//      audience/contextId never appear in the payload, by construction.
//   8. Save closes the dialog and invalidates the list on success.
//   9. An issuer awaiting verification renders its own chip, shows a note in place of
//      the status selector, and never sends `status` on save.
//  10. A pending row shows a Verify action (an active row does not); the dialog shows the
//      challenge fields, submits the pasted token, and closes + invalidates the list on success.
//  11. A refused verify shows the guidance matching its refusal reason, not a generic failure.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DeveloperApi from '../../api/developerApi';
import { IssuersPage } from './IssuersPage';

vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DeveloperApi>();
  return {
    ...actual,
    useDeveloperApi: vi.fn(),
  };
});

const AUTH0_PROD = {
  issuerId: 'auth0-prod',
  issuer: 'https://tenant.us.auth0.com/',
  jwksUri: 'https://tenant.us.auth0.com/.well-known/jwks.json',
  audience: 'https://api.example.com',
  contextId: 'default',
  subClaim: 'sub',
  emailClaim: 'email',
  status: 'active',
  createdAt: '2026-08-01T00:00:00Z',
  selfSignupPolicies: [{ signup_type: 'member', role_id: 'member-role' }],
};

interface MockOverrides {
  listIssuers?: ReturnType<typeof vi.fn>;
  updateIssuer?: ReturnType<typeof vi.fn>;
  verifyIssuer?: ReturnType<typeof vi.fn>;
}

function makeMockDeveloperApi(o: MockOverrides = {}) {
  return {
    listIssuers: o.listIssuers ?? vi.fn().mockResolvedValue(pageOf([AUTH0_PROD])),
    updateIssuer: o.updateIssuer ?? vi.fn().mockResolvedValue({ ...AUTH0_PROD, status: 'suspended' }),
    verifyIssuer: o.verifyIssuer ?? vi.fn().mockResolvedValue({ ...AUTH0_PROD, status: 'active' }),
  };
}

function renderPage(overrides: MockOverrides = {}) {
  const developerApi = makeMockDeveloperApi(overrides);
  vi.mocked(useDeveloperApi).mockReturnValue(developerApi as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <TestIntlProvider>
      <QueryClientProvider client={queryClient}>
        <IssuersPage />
      </QueryClientProvider>
    </TestIntlProvider>,
  );
  return { ...utils, developerApi };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('IssuersPage', () => {
  it('renders the page title + subtitle, with no create affordance', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: /trusted issuers/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/registering a new issuer requires/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create/i })).not.toBeInTheDocument();
  });

  it('shows a loading spinner while listIssuers is in flight', () => {
    renderPage({ listIssuers: vi.fn(() => new Promise(() => undefined)) });
    expect(screen.getByLabelText(/loading issuers/i)).toBeInTheDocument();
  });

  it('shows an accessible error when listIssuers fails', async () => {
    renderPage({ listIssuers: vi.fn().mockRejectedValue(new Error('down')) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load the issuer list/i);
  });

  it('shows the empty state when no issuers are registered', async () => {
    renderPage({ listIssuers: vi.fn().mockResolvedValue(pageOf([])) });
    expect(await screen.findByText(/no trusted issuers registered yet/i)).toBeInTheDocument();
  });

  it('renders one row per issuer with a status chip', async () => {
    renderPage();
    expect(await screen.findByText('auth0-prod')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('opens the edit dialog prefilled, with trust-anchor fields read-only', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('auth0-prod');

    await user.click(screen.getByRole('button', { name: /edit safe fields/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/edit issuer auth0-prod/i)).toBeInTheDocument();
    // Trust-anchor values are shown for reference...
    expect(within(dialog).getByText(AUTH0_PROD.jwksUri)).toBeInTheDocument();
    // ...but not as editable inputs (no textbox holds the jwksUri value).
    expect(within(dialog).queryByDisplayValue(AUTH0_PROD.jwksUri)).not.toBeInTheDocument();
    // Safe fields ARE prefilled editable inputs.
    expect(within(dialog).getByDisplayValue('sub')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('member')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('member-role')).toBeInTheDocument();
  });

  it('save sends ONLY the safe fields, never issuer/jwksUri/audience/contextId', async () => {
    const user = userEvent.setup();
    const { developerApi } = renderPage();
    await screen.findByText('auth0-prod');

    await user.click(screen.getByRole('button', { name: /edit safe fields/i }));
    const dialog = await screen.findByRole('dialog');

    // Flip status to suspended via the select.
    await user.click(within(dialog).getByLabelText(/status/i));
    await user.click(await screen.findByRole('option', { name: 'Suspended' }));

    await user.click(within(dialog).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(developerApi.updateIssuer).toHaveBeenCalledTimes(1));
    const [issuerId, payload] = developerApi.updateIssuer.mock.calls[0] as [string, Record<string, unknown>];
    expect(issuerId).toBe('auth0-prod');
    expect(payload.status).toBe('suspended');
    expect(payload).not.toHaveProperty('issuer');
    expect(payload).not.toHaveProperty('jwksUri');
    expect(payload).not.toHaveProperty('audience');
    expect(payload).not.toHaveProperty('contextId');

    // Dialog closes on success.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('clearing subClaim/emailClaim to blank sends them through (not omitted), so a reset to default reaches the server', async () => {
    const user = userEvent.setup();
    const { developerApi } = renderPage();
    await screen.findByText('auth0-prod');

    await user.click(screen.getByRole('button', { name: /edit safe fields/i }));
    const dialog = await screen.findByRole('dialog');

    const subClaimField = within(dialog).getByDisplayValue('sub');
    await user.clear(subClaimField);
    await user.click(within(dialog).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(developerApi.updateIssuer).toHaveBeenCalledTimes(1));
    const [, payload] = developerApi.updateIssuer.mock.calls[0] as [string, Record<string, unknown>];
    // Sent as an explicit empty string, not omitted — the server's own default-on-blank rule is what
    // actually resets it to "sub"; an omitted field would leave whatever was stored untouched instead.
    expect(payload.subClaim).toBe('');
  });

  // A registration awaiting verification accepts no sign-ins until its registrant proves control of the
  // identity provider. The server refuses any status change on it, so the page must neither render it as
  // active nor send a status on save (which would fail — or, coerced to "active", be an attempt to skip the
  // proof).
  describe('an issuer awaiting verification', () => {
    const PENDING = { ...AUTH0_PROD, status: 'pending_verification' };

    it('renders an "Awaiting verification" chip, not "Active"', async () => {
      renderPage({ listIssuers: vi.fn().mockResolvedValue(pageOf([PENDING])) });
      expect(await screen.findByText('Awaiting verification')).toBeInTheDocument();
      expect(screen.queryByText('Active')).not.toBeInTheDocument();
    });

    it('shows a note instead of a status selector, and save omits status', async () => {
      const user = userEvent.setup();
      const { developerApi } = renderPage({ listIssuers: vi.fn().mockResolvedValue(pageOf([PENDING])) });
      await screen.findByText('auth0-prod');

      await user.click(screen.getByRole('button', { name: /edit safe fields/i }));
      const dialog = await screen.findByRole('dialog');

      expect(within(dialog).getByText(/awaiting verification and does not accept sign-ins yet/i)).toBeInTheDocument();
      expect(within(dialog).queryByLabelText(/^status$/i)).not.toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /save/i }));
      await waitFor(() => expect(developerApi.updateIssuer).toHaveBeenCalledTimes(1));
      const [, payload] = developerApi.updateIssuer.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload).not.toHaveProperty('status');
    });

    it('control: an ACTIVE issuer still sends its status on save', async () => {
      const user = userEvent.setup();
      const { developerApi } = renderPage();
      await screen.findByText('auth0-prod');
      await user.click(screen.getByRole('button', { name: /edit safe fields/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /save/i }));
      await waitFor(() => expect(developerApi.updateIssuer).toHaveBeenCalledTimes(1));
      const [, payload] = developerApi.updateIssuer.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.status).toBe('active');
    });

    it('shows a Verify action on a pending row', async () => {
      renderPage({ listIssuers: vi.fn().mockResolvedValue(pageOf([PENDING])) });
      expect(await screen.findByRole('button', { name: /^verify$/i })).toBeInTheDocument();
    });

    it('control: an ACTIVE row shows no Verify action', async () => {
      renderPage();
      await screen.findByText('auth0-prod');
      expect(screen.queryByRole('button', { name: /^verify$/i })).not.toBeInTheDocument();
    });

    it('opens the verify dialog showing the challenge fields, submits the token, and closes + refreshes on success', async () => {
      const user = userEvent.setup();
      const PENDING_WITH_CHALLENGE = {
        ...PENDING,
        verificationClaim: 'https://vectros.ai/claims/issuer_challenge',
        verificationNonce: 'nonce-abc-123',
        verificationExpiresAt: '2026-10-01T00:00:00Z',
      };
      const { developerApi } = renderPage({
        listIssuers: vi.fn().mockResolvedValue(pageOf([PENDING_WITH_CHALLENGE])),
      });
      await screen.findByText('auth0-prod');

      await user.click(screen.getByRole('button', { name: /^verify$/i }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/verify issuer auth0-prod/i)).toBeInTheDocument();
      expect(within(dialog).getByText('https://vectros.ai/claims/issuer_challenge')).toBeInTheDocument();
      expect(within(dialog).getByText('nonce-abc-123')).toBeInTheDocument();

      const tokenField = within(dialog).getByLabelText(/token/i);
      await user.type(tokenField, 'a.b.c');
      await user.click(within(dialog).getByRole('button', { name: /^verify$/i }));

      await waitFor(() => expect(developerApi.verifyIssuer).toHaveBeenCalledWith('auth0-prod', 'a.b.c'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('trims a pasted token before sending it (a trailing newline is a common paste artifact)', async () => {
      const user = userEvent.setup();
      const { developerApi } = renderPage({ listIssuers: vi.fn().mockResolvedValue(pageOf([PENDING])) });
      await screen.findByText('auth0-prod');

      await user.click(screen.getByRole('button', { name: /^verify$/i }));
      const dialog = await screen.findByRole('dialog');
      // userEvent types literal characters; \n in the source means a real newline goes into the textarea.
      await user.type(within(dialog).getByLabelText(/token/i), '  a.b.c\n');
      await user.click(within(dialog).getByRole('button', { name: /^verify$/i }));

      await waitFor(() => expect(developerApi.verifyIssuer).toHaveBeenCalledWith('auth0-prod', 'a.b.c'));
    });

    it('disables the submit button until a token is entered', async () => {
      const user = userEvent.setup();
      renderPage({ listIssuers: vi.fn().mockResolvedValue(pageOf([PENDING])) });
      await screen.findByText('auth0-prod');
      await user.click(screen.getByRole('button', { name: /^verify$/i }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('button', { name: /^verify$/i })).toBeDisabled();
      await user.type(within(dialog).getByLabelText(/token/i), 'x');
      expect(within(dialog).getByRole('button', { name: /^verify$/i })).toBeEnabled();
    });

    describe('a refused verify shows the matching guidance, not a generic failure', () => {
      class FakeApiError extends Error {
        readonly statusCode: number;
        constructor(statusCode: number, message: string) {
          super(message);
          this.statusCode = statusCode;
        }
      }

      async function submitAndGetAlert(rejection: Error) {
        const user = userEvent.setup();
        renderPage({
          listIssuers: vi.fn().mockResolvedValue(pageOf([PENDING])),
          verifyIssuer: vi.fn().mockRejectedValue(rejection),
        });
        await screen.findByText('auth0-prod');
        await user.click(screen.getByRole('button', { name: /^verify$/i }));
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText(/token/i), 'a.b.c');
        await user.click(within(dialog).getByRole('button', { name: /^verify$/i }));
        return within(await screen.findByRole('alert'));
      }

      it('a bad/expired/wrong-audience token points at retrying with a fresh token', async () => {
        const alert = await submitAndGetAlert(
          new FakeApiError(400, "The token's audience does not include this registration's audience."),
        );
        expect(alert.getByText(/sign in again to mint a fresh token/i)).toBeInTheDocument();
      });

      it('a missing challenge claim points at reconfiguring the identity provider', async () => {
        const alert = await submitAndGetAlert(
          new FakeApiError(400, "The token does not carry the 'https://vectros.ai/claims/issuer_challenge' claim."),
        );
        expect(alert.getByText(/isn't sending the/i)).toBeInTheDocument();
      });

      it('a discovery-document mismatch says it is not fixable from this form', async () => {
        const alert = await submitAndGetAlert(
          new FakeApiError(400, "The issuer's discovery document names a different issuer than the one registered."),
        );
        expect(alert.getByText(/isn't fixable from this form/i)).toBeInTheDocument();
      });

      it('an expired challenge says retrying will not help — re-register instead', async () => {
        const alert = await submitAndGetAlert(
          new FakeApiError(400, "This registration's verification challenge has expired."),
        );
        expect(alert.getByText(/retrying won't help/i)).toBeInTheDocument();
      });

      it('a pair conflict points at the conflicting registration', async () => {
        const alert = await submitAndGetAlert(
          new FakeApiError(400, 'This (issuer, audience) pair is already registered by another registration.'),
        );
        expect(alert.getByText(/already holds this issuer and audience pair/i)).toBeInTheDocument();
      });

      it('"not awaiting verification" says the row changed — reload first', async () => {
        const alert = await submitAndGetAlert(new FakeApiError(400, 'This registration is not awaiting verification.'));
        expect(alert.getByText(/state changed while you were verifying/i)).toBeInTheDocument();
      });

      it('a torn-down app context says no token can fix it', async () => {
        const alert = await submitAndGetAlert(
          new FakeApiError(400, "contextId 'default' does not name an existing app context in your tenant."),
        );
        expect(alert.getByText(/no longer exists or is being torn down/i)).toBeInTheDocument();
      });

      it('a 403 says only the owner can verify', async () => {
        const alert = await submitAndGetAlert(new FakeApiError(403, 'Forbidden'));
        expect(alert.getByText(/only the account owner can verify/i)).toBeInTheDocument();
      });

      it('a 409 says the row changed mid-verify — reload first', async () => {
        const alert = await submitAndGetAlert(
          new FakeApiError(409, 'This registration changed or was removed while it was being verified.'),
        );
        expect(alert.getByText(/state changed while you were verifying/i)).toBeInTheDocument();
      });

      it('an unrecognized refusal falls back to showing the raw message', async () => {
        const alert = await submitAndGetAlert(new FakeApiError(400, 'A brand new refusal the UI has never seen.'));
        expect(alert.getByText(/a brand new refusal the ui has never seen/i)).toBeInTheDocument();
      });
    });
  });
});
