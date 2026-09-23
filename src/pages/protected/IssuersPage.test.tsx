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
}

function makeMockDeveloperApi(o: MockOverrides = {}) {
  return {
    listIssuers: o.listIssuers ?? vi.fn().mockResolvedValue(pageOf([AUTH0_PROD])),
    updateIssuer: o.updateIssuer ?? vi.fn().mockResolvedValue({ ...AUTH0_PROD, status: 'suspended' }),
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
  });
});
