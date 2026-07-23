// ---------------------------------------------------------------------------
// LogsPage tests.
//
// Pinning (the contracts this file locks down):
//   1. Idle state — no query fires before the user clicks Fetch.
//   2. Page meta renders up-front.
//   3. Default time window is "last 1 hour" — start strictly before end.
//   4. Preset chips update pending range without auto-firing the query.
//   5. Clicking Fetch sends a request with the expected ISO-UTC shape. The
//      request body carries NO tenantId — the backend derives the tenant from
//      the caller's token (SDK 0.8.8 dropped the field). The active
//      tenant only selects which partner-API client/token issues the call.
//   6. Empty result set → empty-state copy + hint.
//   7. With entries → table renders all visible columns.
//   8. data.truncated = true → truncation banner visible above the table.
//   9. SDK error → error Alert with the SDK error message.
//  10. Invalid keyId (out of `[A-Za-z0-9_-]{1,64}`) disables Fetch + shows
//      the inline validation message.
//  11. start >= end disables Fetch + shows the time-range validation message.
//  12. Errors-only toggle flips aria-pressed.
//  13. Refresh button — disabled in idle, enabled after first apply, refetches.
// ---------------------------------------------------------------------------

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { VectrosError } from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DeveloperApi from '../../api/developerApi';
import { TestTenantProvider, TEST_TENANT_ID } from '../../test/TestTenantProvider';
import { LogsPage } from './LogsPage';

// Both the context selector AND the logs read go through the owner-gated
// developer API; mock the hook so the whole page is deterministic in tests.
vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DeveloperApi>();
  return {
    ...actual,
    useDeveloperApi: vi.fn(),
  };
});

/** Contexts the selector offers — includes the auto-seeded `default`. */
const CONTEXTS = [
  { contextId: 'vectros-admin' },
  { contextId: 'default' },
  { contextId: 'engineering' },
];

// Three entries spanning the 2xx / 4xx / 5xx classes so we can pin chip
// coloring + row backgrounds in one render.
const SAMPLE_ENTRIES = [
  {
    // An older row where requestId/errorCode serialized as the literal string
    // "null" — must be normalized to "absent" and render nothing.
    timestamp: '2026-05-30T14:23:11.482Z',
    method: 'POST',
    resource: 'documents',
    contextId: 'vectros-admin',
    status: 201,
    keyId: 'key_abc123',
    durationMs: 145,
    path: '/v1/documents',
    requestId: 'null',
    errorCode: 'null',
  },
  {
    timestamp: '2026-05-30T14:23:09.100Z',
    method: 'GET',
    resource: 'records',
    status: 404,
    keyId: 'key_abc123',
    durationMs: 22,
    path: '/v1/records/missing-id',
    requestId: 'req_9f8e7d6c5b4a',
  },
  {
    timestamp: '2026-05-30T14:23:05.000Z',
    method: 'DELETE',
    resource: 'records',
    status: 500,
    keyId: 'key_xyz',
    durationMs: 3100,
    path: '/v1/records/some-id',
  },
  {
    // A typed rejection (0.36+): the row carries both the correlation id and
    // the machine-readable errorCode explaining the 429.
    timestamp: '2026-05-30T14:23:01.000Z',
    method: 'POST',
    resource: 'chat',
    status: 429,
    keyId: 'key_abc123',
    durationMs: 8,
    path: '/v1/chat',
    requestId: 'req_1a2b3c4d5e6f',
    errorCode: 'RATE_LIMITED',
  },
];

const SAMPLE_RESPONSE = {
  entries: SAMPLE_ENTRIES,
  truncated: false,
  queryDurationMs: 412,
  // AdminLogsResponse still echoes the resolved tenantId in the RESPONSE
  // (the request no longer carries it — backend derives it from the token).
  tenantId: TEST_TENANT_ID,
};

interface MockOverrides {
  getAdminLogs?: ReturnType<typeof vi.fn>;
  listAppContexts?: ReturnType<typeof vi.fn>;
}

function makeMockDevApi(overrides: MockOverrides = {}) {
  return {
    getAdminLogs:
      overrides.getAdminLogs ?? vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
    listAppContexts:
      overrides.listAppContexts ??
      vi.fn().mockResolvedValue({ data: CONTEXTS, nextCursor: null }),
    createAppContext: vi.fn(),
    deleteAppContext: vi.fn(),
    listScopedKeys: vi.fn(),
    revokeScopedKey: vi.fn(),
  };
}

function renderPage(opts: { devApi?: ReturnType<typeof makeMockDevApi> } = {}) {
  const devApi = opts.devApi ?? makeMockDevApi();
  vi.mocked(useDeveloperApi).mockReturnValue(devApi as never);
  const utils = render(
    <TestIntlProvider>
      <MemoryRouter>
        <TestTenantProvider>
          <LogsPage />
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { ...utils, devApi };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('LogsPage', () => {
  it('renders the page meta up-front', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: /activity logs/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/request and response bodies are never logged/i),
    ).toBeInTheDocument();
  });

  it('shows the idle state and does NOT fire a query before Fetch is clicked', () => {
    const { devApi } = renderPage();
    expect(
      screen.getByText(/click fetch logs to query/i),
    ).toBeInTheDocument();
    // Query never fires on mount — explicit user action only.
    expect(devApi.getAdminLogs).not.toHaveBeenCalled();
  });

  it('seeds the datetime pickers with the last-1h window', () => {
    // Pin "now" inside this test so the gap calculation is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T15:00:00Z'));
    try {
      renderPage();
      const startTime = screen.getByLabelText(/^from$/i) as HTMLInputElement;
      const endTime = screen.getByLabelText(/^to$/i) as HTMLInputElement;
      // The picker shows local time — its value depends on the test
      // machine's TZ. The invariant we can pin without hard-coding TZ
      // is the ORDERING and the GAP.
      expect(new Date(startTime.value).getTime()).toBeLessThan(
        new Date(endTime.value).getTime(),
      );
      const gapMs =
        new Date(endTime.value).getTime() - new Date(startTime.value).getTime();
      expect(Math.abs(gapMs - 60 * 60 * 1000)).toBeLessThan(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking the 6h preset widens the time window without firing a query', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    const startTime = screen.getByLabelText(/^from$/i) as HTMLInputElement;
    const initialStart = startTime.value;

    await user.click(screen.getByRole('button', { name: '6h' }));

    const newStart = (screen.getByLabelText(/^from$/i) as HTMLInputElement).value;
    expect(newStart).not.toBe(initialStart);
    // 6h window: gap is ~6 hours.
    const endTime = screen.getByLabelText(/^to$/i) as HTMLInputElement;
    const gapMs = new Date(endTime.value).getTime() - new Date(newStart).getTime();
    expect(Math.abs(gapMs - 6 * 60 * 60 * 1000)).toBeLessThan(1000);
    expect(devApi.getAdminLogs).not.toHaveBeenCalled();
  });

  it('clicking Fetch sends a request with the right shape — no tenantId', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    await waitFor(() => {
      expect(devApi.getAdminLogs).toHaveBeenCalledTimes(1);
    });
    const payload = (devApi.getAdminLogs as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;

    // SDK 0.8.8: the request body carries NO tenantId — the backend
    // derives the tenant from the caller's token. The active tenant only
    // selects which partner-API client/token issues the call.
    expect(payload.tenantId).toBeUndefined();
    // startTime + endTime come through as ISO-8601 with millisecond
    // precision (datetime-local strips seconds; new Date() pads).
    expect(payload.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.endTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.limit).toBe(200);
    // Optional fields are omitted (not `undefined`) so the SDK sends no
    // query param at all.
    expect(payload.resource).toBeUndefined();
    expect(payload.method).toBeUndefined();
    expect(payload.keyId).toBeUndefined();
    expect(payload.errorsOnly).toBeUndefined();
  });

  it('renders the entries table with rows from the SDK response', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    const table = await screen.findByRole('table', { name: /api call log entries/i });
    // Three rows visible (the body + the header).
    expect(within(table).getAllByRole('row')).toHaveLength(SAMPLE_ENTRIES.length + 1);
    // Paths from each row, exact match.
    expect(within(table).getByText('/v1/documents')).toBeInTheDocument();
    expect(within(table).getByText('/v1/records/missing-id')).toBeInTheDocument();
    // Status codes as chip labels.
    expect(within(table).getByText('201')).toBeInTheDocument();
    expect(within(table).getByText('404')).toBeInTheDocument();
    expect(within(table).getByText('500')).toBeInTheDocument();
    // Latency cells.
    expect(within(table).getByText('145ms')).toBeInTheDocument();
    expect(within(table).getByText('3100ms')).toBeInTheDocument();
  });

  it('surfaces the per-row requestId and the typed errorCode (0.36+)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    const table = await screen.findByRole('table', { name: /api call log entries/i });
    // The correlation id is shown for rows that carry one, and omitted otherwise.
    expect(within(table).getByText(/Ref: req_9f8e7d6c5b4a/)).toBeInTheDocument();
    expect(within(table).getByText(/Ref: req_1a2b3c4d5e6f/)).toBeInTheDocument();
    // The typed rejection code appears under the status it explains.
    expect(within(table).getByText('RATE_LIMITED')).toBeInTheDocument();
  });

  it('omits an absent, or literal-"null", requestId/errorCode', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    const table = await screen.findByRole('table', { name: /api call log entries/i });
    // Exactly two rows carry a real requestId (the 404 + 429); the literal-"null"
    // row and the rows with no requestId contribute no "Ref:" caption.
    expect(within(table).getAllByText(/^Ref:/)).toHaveLength(2);
    expect(within(table).queryByText(/Ref: null/)).not.toBeInTheDocument();
    // The literal-"null" errorCode is normalized away — only the real typed code
    // (RATE_LIMITED) is shown, never the string "null".
    expect(within(table).queryByText('null')).not.toBeInTheDocument();
  });

  it('renders the empty state when entries is []', async () => {
    const user = userEvent.setup();
    renderPage({
      devApi: makeMockDevApi({
        getAdminLogs: vi.fn().mockResolvedValue({
          ...SAMPLE_RESPONSE,
          entries: [],
        }),
      }),
    });
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/no log entries found in this time window/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/try widening the time range or clearing filters/i),
    ).toBeInTheDocument();
  });

  it('renders the truncation banner when data.truncated is true', async () => {
    const user = userEvent.setup();
    renderPage({
      devApi: makeMockDevApi({
        getAdminLogs: vi.fn().mockResolvedValue({
          ...SAMPLE_RESPONSE,
          truncated: true,
        }),
      }),
    });
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    expect(
      await screen.findByText(/results truncated at 200/i),
    ).toBeInTheDocument();
  });

  it('shows an error Alert on SDK failure', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({ message: 'Not authorized', statusCode: 403 });
    renderPage({
      devApi: makeMockDevApi({
        getAdminLogs: vi.fn().mockRejectedValue(err),
      }),
    });
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/could not query logs\..*not authorized/i),
      ).toBeInTheDocument();
    });
    // The error surface is an announced alert (ApiErrorAlert sets role="alert").
    expect(screen.getByRole('alert')).toHaveTextContent(/could not query logs/i);
  });

  it('surfaces the requestId on the load error (ApiErrorAlert)', async () => {
    const user = userEvent.setup();
    const err = new VectrosError({
      message: 'Not authorized',
      statusCode: 403,
      body: { message: 'Not authorized', requestId: 'req-logs-abc123' },
    });
    renderPage({
      devApi: makeMockDevApi({
        getAdminLogs: vi.fn().mockRejectedValue(err),
      }),
    });
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not query logs/i);
    // The support-correlation id is shown for the user to quote in a ticket.
    expect(alert).toHaveTextContent(/req-logs-abc123/);
  });

  it('shows a screen-reader-labeled spinner while the first fetch is in flight', async () => {
    const user = userEvent.setup();
    // Keep the call pending so the loading state stays mounted for the assertion.
    let resolveFetch: ((value: unknown) => void) | undefined;
    const getAdminLogs = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderPage({ devApi: makeMockDevApi({ getAdminLogs }) });
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));

    // LoadingBlock renders a CircularProgress with an accessible label — a
    // bare spinner would announce nothing to assistive tech.
    expect(
      await screen.findByRole('progressbar', { name: /querying logs/i }),
    ).toBeInTheDocument();

    // Drain the pending promise so the test exits cleanly.
    resolveFetch?.(SAMPLE_RESPONSE);
  });

  it('invalid keyId disables Fetch and shows the inline error', async () => {
    const user = userEvent.setup();
    renderPage();
    const keyIdInput = screen.getByLabelText(/^key id$/i);
    await user.type(keyIdInput, 'has spaces!');

    expect(
      await screen.findByText(
        /use only letters, digits, hyphens, or underscores/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fetch logs/i })).toBeDisabled();
  });

  it('start >= end disables Fetch and shows the time-range error', async () => {
    renderPage();
    const startTime = screen.getByLabelText(/^from$/i) as HTMLInputElement;
    // Set From to AFTER To via fireEvent.change — the canonical way to drive
    // a controlled input from a test (userEvent.type on datetime-local
    // doesn't reliably edit the value across browsers).
    fireEvent.change(startTime, { target: { value: '2030-01-01T00:00' } });

    expect(
      await screen.findByText(/start time must be before end time/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fetch logs/i })).toBeDisabled();
  });

  it('errors-only toggle flips aria-pressed and applies as a filter', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    const toggle = screen.getByRole('button', { name: /errors only/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /fetch logs/i }));
    await waitFor(() => {
      expect(devApi.getAdminLogs).toHaveBeenCalledTimes(1);
    });
    const payload = (devApi.getAdminLogs as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(payload.errorsOnly).toBe(true);
  });

  it('Refresh is disabled in idle, enabled after Apply, and refetches on click', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    const refresh = screen.getByRole('button', { name: /^refresh$/i });
    expect(refresh).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /fetch logs/i }));
    await waitFor(() => {
      expect(devApi.getAdminLogs).toHaveBeenCalledTimes(1);
    });
    expect(refresh).toBeEnabled();

    await user.click(refresh);
    await waitFor(() => {
      expect(devApi.getAdminLogs).toHaveBeenCalledTimes(2);
    });
  });

  it('selecting a resource + method applies them as filters', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    // Open the Resource Select and pick 'documents'.
    await user.click(screen.getByLabelText(/^resource$/i));
    await user.click(await screen.findByRole('option', { name: /^documents$/i }));
    // Open the Method Select and pick 'POST'.
    await user.click(screen.getByLabelText(/^method$/i));
    await user.click(await screen.findByRole('option', { name: /^post$/i }));

    await user.click(screen.getByRole('button', { name: /fetch logs/i }));
    await waitFor(() => {
      expect(devApi.getAdminLogs).toHaveBeenCalledTimes(1);
    });
    const payload = (devApi.getAdminLogs as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(payload.resource).toBe('documents');
    expect(payload.method).toBe('POST');
  });

  it('offers the identity + generalized resource filters (matches the backend allow-list)', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    await user.click(screen.getByLabelText(/^resource$/i));
    // The generic IdentityEntityDB surface + the previously-drifted resource types.
    for (const r of ['entities', 'namespaces', 'erasure-requests', 'export']) {
      expect(await screen.findByRole('option', { name: new RegExp(`^${r}$`) })).toBeInTheDocument();
    }
    // And a new value flows through to the request unchanged.
    await user.click(await screen.findByRole('option', { name: /^entities$/ }));
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));
    await waitFor(() => expect(devApi.getAdminLogs).toHaveBeenCalledTimes(1));
    const payload = (devApi.getAdminLogs as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(payload.resource).toBe('entities');
  });

  // ---- dev-portal parity: horizon indicator, auto-refetch, context column ----

  it('shows the active time-horizon and updates it when a preset is picked', async () => {
    const user = userEvent.setup();
    renderPage();
    // Default window is the last hour.
    expect(screen.getByText(/showing last 1h/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '6h' }));
    expect(screen.getByText(/showing last 6h/i)).toBeInTheDocument();
  });

  it('switches the indicator to "custom range" when From is edited by hand', () => {
    renderPage();
    expect(screen.getByText(/showing last 1h/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: '2026-05-01T10:00' },
    });
    expect(screen.getByText(/showing custom range/i)).toBeInTheDocument();
  });

  it('auto-refetches when a discrete filter changes after the first fetch', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));
    await waitFor(() => expect(devApi.getAdminLogs).toHaveBeenCalledTimes(1));

    // A preset pick now re-queries immediately — no second Fetch press needed.
    await user.click(screen.getByRole('button', { name: '6h' }));
    await waitFor(() => expect(devApi.getAdminLogs).toHaveBeenCalledTimes(2));

    // So does toggling errors-only.
    await user.click(screen.getByRole('button', { name: /errors only/i }));
    await waitFor(() => expect(devApi.getAdminLogs).toHaveBeenCalledTimes(3));
  });

  it('does NOT auto-refetch on a filter change before the first fetch', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    // No fetch yet — picking a preset updates the window but fires no query.
    await user.click(screen.getByRole('button', { name: '6h' }));
    await user.click(screen.getByRole('button', { name: /errors only/i }));
    expect(devApi.getAdminLogs).not.toHaveBeenCalled();
  });

  it('renders the Context column with each entry’s contextId', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));
    const table = await screen.findByRole('table', { name: /api call log entries/i });
    expect(within(table).getByText(/^context$/i)).toBeInTheDocument();
    expect(within(table).getByText('vectros-admin')).toBeInTheDocument();
  });

  it('defaults to ALL contexts — the first read carries no context filter', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));
    await waitFor(() => expect(devApi.getAdminLogs).toHaveBeenCalledTimes(1));
    // Tenant-wide by default: no contextId is sent, so the read spans every
    // context (the account-wide view the old per-context stopgap couldn't give).
    const query = devApi.getAdminLogs.mock.calls[0]![0] as { contextId?: string };
    expect(query.contextId).toBeUndefined();
  });

  it('refetches with a contextId filter when the selector narrows to a context', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    await user.click(screen.getByRole('button', { name: /fetch logs/i }));
    await waitFor(() => expect(devApi.getAdminLogs).toHaveBeenCalledTimes(1));

    // Narrow the Context selector to a single context.
    await user.click(screen.getByLabelText(/^context$/i));
    await user.click(await screen.findByRole('option', { name: /^engineering$/i }));

    // The switch re-queries on its own (no second Fetch press), now filtered to
    // that context (not a separate per-context credential).
    await waitFor(() => expect(devApi.getAdminLogs).toHaveBeenCalledTimes(2));
    const query = devApi.getAdminLogs.mock.calls[1]![0] as { contextId?: string };
    expect(query.contextId).toBe('engineering');
  });
});
