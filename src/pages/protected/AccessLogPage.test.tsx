// ---------------------------------------------------------------------------
// AccessLogPage tests.
//
// Pinning (the contracts this file locks down):
//   1. Page meta + the standing coverage caveat render up-front.
//   2. Idle state — no query fires before the required axes are set + Fetch.
//   3. Fetch is gated until a context AND a subject id are provided.
//   4. Clicking Fetch sends the expected request shape — contextId + subject
//      axes present, NO tenantId, optional filters omitted — and mints the
//      bearer for the SELECTED context (context-binding contract).
//   5. Rows render, including the accounting-critical revealedSensitive column
//      (a warning "Revealed" chip when true, a muted "No" when false).
//   6. Empty result → the empty copy AND the "logging may be disabled" hint
//      (lock #3: an empty table must never read as "no one accessed this
//      subject").
//   7. SDK error → error alert with the SDK message + the requestId.
//   8. The revealed-sensitive filter sends revealedSensitive true/false, and
//      'Any' omits it; the action filter sends `action`.
//   9. Optional clientId + from/to flow through (from/to as ISO-8601 UTC).
//  10. start >= end disables Fetch + shows the time-range message.
//  11. Cursor pagination — "Load more" fetches the next page (with startFrom)
//      and appends its rows.
//  12. A discrete filter change after the first fetch re-queries immediately.
// ---------------------------------------------------------------------------

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import type { ReadAccessLogPage, ReadAccessLogRow } from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DeveloperApi from '../../api/developerApi';
import { TestTenantProvider, TEST_TENANT_ID } from '../../test/TestTenantProvider';
import { AccessLogPage } from './AccessLogPage';

// The read-access query goes through the partner-API SDK client; the context
// list through the owner-gated developer API. Mock both so the page is
// deterministic.
vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return { ...actual, vectrosApiClient: vi.fn() };
});
vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DeveloperApi>();
  return { ...actual, useDeveloperApi: vi.fn() };
});

// ---- fixtures ------------------------------------------------------------

const CONTEXTS = [{ contextId: 'ctx_intake' }, { contextId: 'engineering' }];

const SAMPLE_ROWS = [
  {
    id: 'ral_1',
    contextId: 'ctx_intake',
    subjectType: 'user',
    subjectId: 'user_abc',
    callerKeyId: 'key_root',
    action: 'read',
    resourceType: 'intake_form',
    resourceId: 'rec_1',
    revealedSensitive: true,
    createdAt: '2026-05-30T14:23:11.482Z',
  },
  {
    id: 'ral_2',
    contextId: 'ctx_intake',
    subjectType: 'user',
    subjectId: 'user_abc',
    callerKeyId: 'key_scoped',
    action: 'search',
    resourceType: 'search',
    resourceId: 'rec_2',
    clientId: 'client_x',
    revealedSensitive: false,
    createdAt: '2026-05-30T14:20:00.000Z',
  },
] satisfies ReadAccessLogRow[];

// A sparse row — the accounting query legitimately returns rows with absent
// optional fields (no resourceId, no caller, no client, undefined reveal). The
// cell fallbacks (em dash + "No") must render for these.
const SPARSE_ROW = {
  id: 'ral_sparse',
  contextId: 'ctx_intake',
  subjectType: 'user',
  subjectId: 'user_abc',
  action: 'list',
} satisfies ReadAccessLogRow;

const SAMPLE_PAGE = { data: SAMPLE_ROWS, nextCursor: null } satisfies ReadAccessLogPage;

interface ClientOverrides {
  getAccessLog?: ReturnType<typeof vi.fn>;
}

function makeMockClient(o: ClientOverrides = {}) {
  return {
    auth: {
      getAccessLog: o.getAccessLog ?? vi.fn().mockResolvedValue(SAMPLE_PAGE),
    },
  };
}

function makeMockDevApi() {
  return {
    listAppContexts: vi.fn().mockResolvedValue({ data: CONTEXTS, nextCursor: null }),
    createAppContext: vi.fn(),
    deleteAppContext: vi.fn(),
    listScopedKeys: vi.fn(),
    revokeScopedKey: vi.fn(),
    getAdminLogs: vi.fn(),
  };
}

function renderPage(opts: { client?: ReturnType<typeof makeMockClient> } = {}) {
  const client = opts.client ?? makeMockClient();
  const devApi = makeMockDevApi();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  vi.mocked(useDeveloperApi).mockReturnValue(devApi as never);
  const utils = render(
    <TestIntlProvider>
      <MemoryRouter>
        <TestTenantProvider>
          <AccessLogPage />
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { ...utils, client, devApi };
}

/** The getAccessLog mock on a rendered client, typed for `.mock.calls`. */
function getAccessLogMock(client: ReturnType<typeof makeMockClient>): ReturnType<typeof vi.fn> {
  return client.auth.getAccessLog as ReturnType<typeof vi.fn>;
}

/** Pick a context from the (async-loaded) required selector. */
async function selectContext(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<void> {
  const trigger = await screen.findByLabelText(/context/i);
  // The selector is disabled until the context list loads.
  await waitFor(() => expect(trigger).not.toHaveAttribute('aria-disabled', 'true'));
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name }));
}

/** Open a MUI Select by its label and pick an option. */
async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  labelRe: RegExp,
  optionRe: RegExp,
): Promise<void> {
  await user.click(screen.getByLabelText(labelRe));
  await user.click(await screen.findByRole('option', { name: optionRe }));
}

/** Fill the required identity axes (context + subject id) so Fetch enables. */
async function fillRequired(
  user: ReturnType<typeof userEvent.setup>,
  subjectId = 'user_abc',
): Promise<void> {
  await selectContext(user, /ctx_intake/i);
  await user.type(screen.getByLabelText(/subject id/i), subjectId);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AccessLogPage', () => {
  it('renders the page meta and the standing coverage caveat', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: /accounting of disclosures/i }),
    ).toBeInTheDocument();
    // The critical framing: an empty result is ambiguous, and logging is off by default.
    expect(
      screen.getByText(/does not mean no one accessed this subject/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/opt-in and off by default/i)).toBeInTheDocument();
  });

  it('shows the idle state and fires no query before Fetch', () => {
    const { client } = renderPage();
    expect(screen.getByText(/choose a context and enter a subject/i)).toBeInTheDocument();
    expect(getAccessLogMock(client)).not.toHaveBeenCalled();
  });

  it('gates Fetch until both a context and a subject id are provided', async () => {
    const user = userEvent.setup();
    renderPage();
    const fetchBtn = screen.getByRole('button', { name: /fetch disclosures/i });
    // Nothing selected yet.
    expect(fetchBtn).toBeDisabled();

    // Context alone is not enough.
    await selectContext(user, /ctx_intake/i);
    expect(screen.getByRole('button', { name: /fetch disclosures/i })).toBeDisabled();

    // Add a subject id → enabled.
    await user.type(screen.getByLabelText(/subject id/i), 'user_abc');
    expect(screen.getByRole('button', { name: /fetch disclosures/i })).toBeEnabled();
  });

  it('sends the expected request shape and mints the bearer for the selected context', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalledTimes(1));
    const payload = getAccessLogMock(client).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.contextId).toBe('ctx_intake');
    expect(payload.subjectType).toBe('user');
    expect(payload.subjectId).toBe('user_abc');
    expect(payload.limit).toBe(200);
    // Tenant is derived server-side from the token — never sent.
    expect(payload.tenantId).toBeUndefined();
    // Optional filters omitted entirely (not `undefined`) so no query param is sent.
    expect(payload.clientId).toBeUndefined();
    expect(payload.action).toBeUndefined();
    expect(payload.revealedSensitive).toBeUndefined();
    expect(payload.from).toBeUndefined();
    expect(payload.to).toBeUndefined();
    expect(payload.startFrom).toBeUndefined();

    // The bearer is minted for the SELECTED context (context-binding contract).
    expect(vi.mocked(vectrosApiClient)).toHaveBeenCalledWith(TEST_TENANT_ID, 'ctx_intake');
  });

  it('renders rows including the revealedSensitive column (revealed + masked)', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    const table = await screen.findByRole('table', { name: /read-access disclosure rows/i });
    // Header + two data rows.
    expect(within(table).getAllByRole('row')).toHaveLength(SAMPLE_ROWS.length + 1);
    // Resource cells (type:id).
    expect(within(table).getByText('intake_form:rec_1')).toBeInTheDocument();
    expect(within(table).getByText('search:rec_2')).toBeInTheDocument();
    // Caller + client cells.
    expect(within(table).getByText('key_root')).toBeInTheDocument();
    expect(within(table).getByText('client_x')).toBeInTheDocument();
    // revealedSensitive=true → a "Revealed" chip; the masked row shows "No".
    expect(within(table).getByText(/^revealed$/i)).toBeInTheDocument();
    expect(within(table).getByText(/^no$/i)).toBeInTheDocument();
  });

  it('renders the empty state with the logging-disabled hint (not just "no access")', async () => {
    const user = userEvent.setup();
    renderPage({
      client: makeMockClient({
        getAccessLog: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
      }),
    });
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    await waitFor(() =>
      expect(screen.getByText(/no recorded disclosures for/i)).toBeInTheDocument(),
    );
    // Lock #3: the empty state must surface that logging is off by default and
    // disclosures are simply not recorded when disabled.
    expect(
      screen.getByText(/read-access logging is enabled for this context/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/disclosures are not recorded and cannot appear here/i),
    ).toBeInTheDocument();
  });

  it('shows an error alert with the SDK message and requestId', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'Not authorized',
      statusCode: 403,
      body: { message: 'Not authorized', requestId: 'req-acc-abc123' },
    });
    renderPage({
      client: makeMockClient({ getAccessLog: vi.fn().mockRejectedValue(err) }),
    });
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not query the read-access log/i);
    expect(alert).toHaveTextContent(/not authorized/i);
    expect(alert).toHaveTextContent(/req-acc-abc123/);
  });

  it('sends revealedSensitive=true when the Revealed filter is picked', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /^revealed$/i }));
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalled());
    const payload = getAccessLogMock(client).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload.revealedSensitive).toBe(true);
  });

  it('sends revealedSensitive=false when the Masked filter is picked', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /^masked$/i }));
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalled());
    const payload = getAccessLogMock(client).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload.revealedSensitive).toBe(false);
  });

  it('sends the action filter and optional clientId', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await fillRequired(user);
    await user.type(screen.getByLabelText(/client id/i), 'client_x');
    // Pick an action.
    await user.click(screen.getByLabelText(/^action$/i));
    await user.click(await screen.findByRole('option', { name: /^read$/i }));

    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));
    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalled());
    const payload = getAccessLogMock(client).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload.action).toBe('read');
    expect(payload.clientId).toBe('client_x');
  });

  it('converts the from/to window to ISO-8601 UTC', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await fillRequired(user);
    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: '2026-05-01T00:00' },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: '2026-06-01T00:00' },
    });
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalled());
    const payload = getAccessLogMock(client).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('start >= end disables Fetch and shows the time-range error', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: '2030-01-01T00:00' },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: '2029-01-01T00:00' },
    });
    expect(
      await screen.findByText(/start time must be before end time/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fetch disclosures/i })).toBeDisabled();
  });

  it('paginates: Load more fetches the next page with startFrom and appends rows', async () => {
    const user = userEvent.setup();
    const getAccessLog = vi
      .fn()
      .mockResolvedValueOnce({ data: [SAMPLE_ROWS[0]], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ data: [SAMPLE_ROWS[1]], nextCursor: null });
    const { client } = renderPage({ client: makeMockClient({ getAccessLog }) });
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    // First page loaded — one row + a Load more button.
    expect(await screen.findByText('intake_form:rec_1')).toBeInTheDocument();
    const loadMore = await screen.findByRole('button', { name: /load more/i });

    await user.click(loadMore);

    // Second page appended, and the fetch carried the cursor as startFrom.
    expect(await screen.findByText('search:rec_2')).toBeInTheDocument();
    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalledTimes(2));
    const secondCall = getAccessLogMock(client).mock.calls[1]?.[0] as Record<string, unknown>;
    expect(secondCall.startFrom).toBe('cursor-2');
    // The next page carries the same applied query — not just the cursor.
    expect(secondCall.contextId).toBe('ctx_intake');
    expect(secondCall.subjectId).toBe('user_abc');
    // No more pages → the button is gone.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument(),
    );
  });

  it('re-queries immediately on a discrete filter change after the first fetch', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));
    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalledTimes(1));

    // Toggling the revealed filter re-queries without a second Fetch press.
    await user.click(screen.getByRole('button', { name: /^revealed$/i }));
    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalledTimes(2));
  });

  it('sends a non-default subjectType (org)', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await selectContext(user, /ctx_intake/i);
    await pickOption(user, /subject type/i, /^org$/i);
    await user.type(screen.getByLabelText(/subject id/i), 'org_42');
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalled());
    const payload = getAccessLogMock(client).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload.subjectType).toBe('org');
    expect(payload.subjectId).toBe('org_42');
  });

  it('re-mints the bearer for the NEW context when the context selector changes', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));
    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalledTimes(1));

    // Switch context → auto re-query. Context-binding follows the selection:
    // the query must both target the new context AND be issued with a bearer
    // minted for it (security-relevant).
    await pickOption(user, /context/i, /^engineering$/i);
    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalledTimes(2));
    const payload = getAccessLogMock(client).mock.calls[1]?.[0] as Record<string, unknown>;
    expect(payload.contextId).toBe('engineering');
    expect(vi.mocked(vectrosApiClient)).toHaveBeenCalledWith(TEST_TENANT_ID, 'engineering');
  });

  it('a discrete toggle does NOT commit an un-fetched subject-id edit', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await fillRequired(user); // subject = user_abc
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));
    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalledTimes(1));

    // Type a NEW subject id but do not Fetch — this is a free-text edit that
    // must wait for an explicit Fetch.
    const subjectInput = screen.getByLabelText(/subject id/i);
    await user.clear(subjectInput);
    await user.type(subjectInput, 'user_SHOULD_NOT_APPLY');

    // Toggling a discrete filter re-queries — but on the LAST APPLIED subject,
    // not the half-typed one. (Regression guard for the whole-form auto-apply
    // bug where the discrete toggle silently shifted the queried subject.)
    await user.click(screen.getByRole('button', { name: /^revealed$/i }));
    await waitFor(() => expect(getAccessLogMock(client)).toHaveBeenCalledTimes(2));
    const payload = getAccessLogMock(client).mock.calls[1]?.[0] as Record<string, unknown>;
    expect(payload.subjectId).toBe('user_abc');
    expect(payload.revealedSensitive).toBe(true);
    // The results header still describes the applied subject, not the edit.
    expect(screen.getByText(/user:user_abc/i)).toBeInTheDocument();
  });

  it('renders em-dash + "No" fallbacks for a sparse row', async () => {
    const user = userEvent.setup();
    renderPage({
      client: makeMockClient({
        getAccessLog: vi.fn().mockResolvedValue({ data: [SPARSE_ROW], nextCursor: null }),
      }),
    });
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /fetch disclosures/i }));

    const table = await screen.findByRole('table', { name: /read-access disclosure rows/i });
    // Undefined revealedSensitive renders the muted "No", never a false positive.
    expect(within(table).getByText(/^no$/i)).toBeInTheDocument();
    // Absent resource / caller / client / timestamp render the em-dash fallback.
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
  });
});
