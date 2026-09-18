// ---------------------------------------------------------------------------
// TriggerFailuresPage tests.
//
// Pinning (the contracts this file locks down):
//   1. Page meta renders; no query fires before Fetch.
//   2. Fetch with no filters set is account-wide (no contextId param sent).
//   3. Rows render; the empty and error states render.
//   4. The context/ruleId/category/retryable/from-to filters flow through.
//   5. Cursor pagination — "Load more" fetches the next page with startFrom.
//   6. Refresh re-runs from the FIRST page (resetQueries), never refetch(),
//      which would re-fetch every loaded page instead of just resuming.
//   7. incomplete/contextsNotSearched: the warning banner renders when set,
//      names the contexts, and stays visible (aggregated) after Load more
//      even though only the FIRST page carried the flag.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DeveloperApi from '../../api/developerApi';
import type { TriggerFailureEntry, TriggerFailuresResponse } from '../../api/developerApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { TriggerFailuresPage } from './TriggerFailuresPage';

vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DeveloperApi>();
  return { ...actual, useDeveloperApi: vi.fn() };
});

// ---- fixtures --------------------------------------------------------------

const CONTEXTS = [{ contextId: 'ctx_intake' }, { contextId: 'engineering' }];

const SAMPLE_ROWS = [
  {
    id: 'tf_1',
    contextId: 'ctx_intake',
    ruleId: 'rule_a',
    ruleName: 'on-intake-create',
    category: 'SCRIPT_ERROR',
    retryable: false,
    detail: 'Item rec_7f3a91 was modified by another writer.',
    attempts: 3,
    createdAt: '2026-05-30T14:23:11.482Z',
  },
  {
    id: 'tf_2',
    contextId: 'ctx_intake',
    ruleId: 'rule_b',
    ruleName: 'on-record-update',
    category: 'TIMEOUT',
    retryable: true,
    attempts: 1,
    createdAt: '2026-05-30T14:20:00.000Z',
  },
] satisfies TriggerFailureEntry[];

const SPARSE_ROW = {
  id: 'tf_sparse',
  contextId: 'ctx_intake',
  ruleId: 'rule_c',
  category: 'INTERNAL_ERROR',
  correlationId: 'tf_sparse',
} satisfies TriggerFailureEntry;

const SAMPLE_PAGE: TriggerFailuresResponse = {
  data: SAMPLE_ROWS,
  nextCursor: null,
  incomplete: false,
  contextsNotSearched: [], contextListUnavailable: false,
};

function makeMockDevApi(overrides: { getTriggerFailures?: ReturnType<typeof vi.fn> } = {}) {
  return {
    listAppContexts: vi.fn().mockResolvedValue({ data: CONTEXTS, nextCursor: null }),
    createAppContext: vi.fn(),
    deleteAppContext: vi.fn(),
    listIssuers: vi.fn(),
    updateIssuer: vi.fn(),
    listScopedKeys: vi.fn(),
    revokeScopedKey: vi.fn(),
    getAdminLogs: vi.fn(),
    getTriggerFailures: overrides.getTriggerFailures ?? vi.fn().mockResolvedValue(SAMPLE_PAGE),
    transferOwnership: vi.fn(),
  };
}

function renderPage(opts: { devApi?: ReturnType<typeof makeMockDevApi> } = {}) {
  const devApi = opts.devApi ?? makeMockDevApi();
  vi.mocked(useDeveloperApi).mockReturnValue(devApi as never);
  const utils = render(
    <TestIntlProvider>
      <MemoryRouter>
        <TestTenantProvider>
          <TriggerFailuresPage />
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { ...utils, devApi };
}

function getTriggerFailuresMock(devApi: ReturnType<typeof makeMockDevApi>): ReturnType<typeof vi.fn> {
  return devApi.getTriggerFailures as ReturnType<typeof vi.fn>;
}

async function clickFetch(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /fetch failures/i }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('TriggerFailuresPage', () => {
  it('renders the page meta', () => {
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: /trigger failures/i }),
    ).toBeInTheDocument();
  });

  it('shows the idle state and fires no query before Fetch', () => {
    const { devApi } = renderPage();
    expect(screen.getByText(/fetch to see failed automations/i)).toBeInTheDocument();
    expect(getTriggerFailuresMock(devApi)).not.toHaveBeenCalled();
  });

  it('Fetch with no filters set is account-wide — no contextId sent', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    await clickFetch(user);
    await waitFor(() => expect(getTriggerFailuresMock(devApi)).toHaveBeenCalled());
    const call = getTriggerFailuresMock(devApi).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('contextId');
    expect(call.limit).toBeGreaterThan(0);
  });

  it('renders rows, including the em-dash fallback for a sparse row', async () => {
    const user = userEvent.setup();
    const devApi = makeMockDevApi({
      getTriggerFailures: vi.fn().mockResolvedValue({
        data: [...SAMPLE_ROWS, SPARSE_ROW],
        nextCursor: null,
        incomplete: false,
        contextsNotSearched: [], contextListUnavailable: false,
      }),
    });
    renderPage({ devApi });
    await clickFetch(user);
    expect(await screen.findByText('on-intake-create')).toBeInTheDocument();
    expect(screen.getByText('on-record-update')).toBeInTheDocument();
    // Sparse row: no ruleName → falls back to ruleId.
    expect(screen.getByText('rule_c')).toBeInTheDocument();
    // Sparse row's correlationId is shown in the detail cell (INTERNAL_ERROR contract).
    expect(screen.getAllByText(/tf_sparse/).length).toBeGreaterThan(0);
  });

  it('renders the empty state', async () => {
    const user = userEvent.setup();
    const devApi = makeMockDevApi({
      getTriggerFailures: vi.fn().mockResolvedValue({
        data: [],
        nextCursor: null,
        incomplete: false,
        contextsNotSearched: [], contextListUnavailable: false,
      }),
    });
    renderPage({ devApi });
    await clickFetch(user);
    expect(await screen.findByText(/no trigger failures found/i)).toBeInTheDocument();
  });

  it('shows an error alert with the SDK message', async () => {
    const user = userEvent.setup();
    const devApi = makeMockDevApi({
      getTriggerFailures: vi.fn().mockRejectedValue(new Error('boom')),
    });
    renderPage({ devApi });
    await clickFetch(user);
    expect(await screen.findByText(/could not query trigger failures/i)).toBeInTheDocument();
  });

  it('sends the selected context filter', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    const trigger = await screen.findByLabelText(/^context$/i);
    await waitFor(() => expect(trigger).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: /ctx_intake/i }));
    await clickFetch(user);
    await waitFor(() =>
      expect(getTriggerFailuresMock(devApi)).toHaveBeenCalledWith(
        expect.objectContaining({ contextId: 'ctx_intake' }),
      ),
    );
  });

  it('sends ruleId, category and the retryable filter', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    await user.type(screen.getByLabelText(/rule id/i), 'rule_a');
    await user.type(screen.getByLabelText(/category/i), 'SCRIPT_ERROR');
    await user.click(screen.getByRole('button', { name: /^not retryable$/i }));
    await clickFetch(user);
    await waitFor(() =>
      expect(getTriggerFailuresMock(devApi)).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleId: 'rule_a',
          category: 'SCRIPT_ERROR',
          retryable: false,
        }),
      ),
    );
  });

  it('converts the from/to window to ISO-8601 UTC', async () => {
    const user = userEvent.setup();
    const { devApi } = renderPage();
    const fromInput = screen.getByLabelText(/^from$/i);
    const toInput = screen.getByLabelText(/^to$/i);
    await user.type(fromInput, '2026-05-01T00:00');
    await user.type(toInput, '2026-05-02T00:00');
    await clickFetch(user);
    await waitFor(() => expect(getTriggerFailuresMock(devApi)).toHaveBeenCalled());
    const call = getTriggerFailuresMock(devApi).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.from).toBe(new Date('2026-05-01T00:00').toISOString());
    expect(call.to).toBe(new Date('2026-05-02T00:00').toISOString());
  });

  it('start >= end disables Fetch and shows the time-range error', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/^from$/i), '2026-05-02T00:00');
    await user.type(screen.getByLabelText(/^to$/i), '2026-05-01T00:00');
    expect(screen.getByRole('button', { name: /fetch failures/i })).toBeDisabled();
    expect(screen.getByText(/start time must be before end time/i)).toBeInTheDocument();
  });

  it('paginates: Load more fetches the next page with startFrom and appends rows', async () => {
    const user = userEvent.setup();
    const getTriggerFailures = vi
      .fn()
      .mockResolvedValueOnce({
        data: [SAMPLE_ROWS[0]],
        nextCursor: 'cursor_page2',
        incomplete: false,
        contextsNotSearched: [], contextListUnavailable: false,
      })
      .mockResolvedValueOnce({
        data: [SAMPLE_ROWS[1]],
        nextCursor: null,
        incomplete: false,
        contextsNotSearched: [], contextListUnavailable: false,
      });
    const devApi = makeMockDevApi({ getTriggerFailures });
    renderPage({ devApi });
    await clickFetch(user);
    expect(await screen.findByText('on-intake-create')).toBeInTheDocument();
    expect(screen.queryByText('on-record-update')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('on-record-update')).toBeInTheDocument();
    expect(getTriggerFailures).toHaveBeenLastCalledWith(
      expect.objectContaining({ startFrom: 'cursor_page2' }),
    );
  });

  it('Refresh re-runs from the FIRST page, not refetch() — never re-walks every loaded page', async () => {
    const user = userEvent.setup();
    const getTriggerFailures = vi
      .fn()
      .mockResolvedValueOnce({
        data: [SAMPLE_ROWS[0]],
        nextCursor: 'cursor_page2',
        incomplete: false,
        contextsNotSearched: [], contextListUnavailable: false,
      })
      .mockResolvedValueOnce({
        data: [SAMPLE_ROWS[1]],
        nextCursor: null,
        incomplete: false,
        contextsNotSearched: [], contextListUnavailable: false,
      })
      .mockResolvedValue({
        data: [SAMPLE_ROWS[0]],
        nextCursor: null,
        incomplete: false,
        contextsNotSearched: [], contextListUnavailable: false,
      });
    const devApi = makeMockDevApi({ getTriggerFailures });
    renderPage({ devApi });
    await clickFetch(user);
    await screen.findByText('on-intake-create');
    await user.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText('on-record-update');
    getTriggerFailures.mockClear();

    await user.click(screen.getByRole('button', { name: /^refresh$/i }));
    await waitFor(() => expect(getTriggerFailures).toHaveBeenCalledTimes(1));
    // A single call for page one only — never two calls re-walking both loaded pages.
    const call = getTriggerFailures.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('startFrom');
  });

  it('shows the incomplete warning with the not-searched contexts named', async () => {
    const user = userEvent.setup();
    const devApi = makeMockDevApi({
      getTriggerFailures: vi.fn().mockResolvedValue({
        data: SAMPLE_ROWS,
        nextCursor: null,
        incomplete: true,
        contextsNotSearched: ['ctx_intake'], contextListUnavailable: false,
      }),
    });
    renderPage({ devApi });
    await clickFetch(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be read/i);
    // Scoped to the alert — "ctx_intake" also appears in the results table's own context column.
    expect(alert).toHaveTextContent(/ctx_intake/);
  });

  it('keeps the incomplete warning visible after Load more even though only page one flagged it', async () => {
    const user = userEvent.setup();
    const getTriggerFailures = vi
      .fn()
      .mockResolvedValueOnce({
        data: [SAMPLE_ROWS[0]],
        nextCursor: 'cursor_page2',
        incomplete: true,
        contextsNotSearched: ['ctx_intake'], contextListUnavailable: false,
      })
      .mockResolvedValueOnce({
        data: [SAMPLE_ROWS[1]],
        nextCursor: null,
        incomplete: false,
        contextsNotSearched: [], contextListUnavailable: false,
      });
    const devApi = makeMockDevApi({ getTriggerFailures });
    renderPage({ devApi });
    await clickFetch(user);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText('on-record-update');
    // Still visible — the aggregation must not drop page one's flag once page two loads.
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be read/i);
  });

  it('uses different copy when incomplete but no context is named (a partially-hydrated page)', async () => {
    const user = userEvent.setup();
    const devApi = makeMockDevApi({
      getTriggerFailures: vi.fn().mockResolvedValue({
        data: SAMPLE_ROWS,
        nextCursor: null,
        incomplete: true,
        contextsNotSearched: [], contextListUnavailable: false,
      }),
    });
    renderPage({ devApi });
    await clickFetch(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be read/i);
    expect(alert).not.toHaveTextContent(/not searched:/i);
    expect(alert).toHaveTextContent(/only partially read/i);
  });

  it('a zero-row page with a cursor shows "more to search" copy, not the terminal empty state', async () => {
    const user = userEvent.setup();
    const getTriggerFailures = vi
      .fn()
      .mockResolvedValueOnce({
        data: [], nextCursor: 'cursor_page2', incomplete: false, contextsNotSearched: [], contextListUnavailable: false,
      })
      .mockResolvedValueOnce({
        data: [SAMPLE_ROWS[0]], nextCursor: null, incomplete: false, contextsNotSearched: [], contextListUnavailable: false,
      });
    const devApi = makeMockDevApi({ getTriggerFailures });
    renderPage({ devApi });
    await clickFetch(user);

    expect(await screen.findByText(/more of your account left to check/i)).toBeInTheDocument();
    expect(screen.queryByText(/no trigger failures found/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('on-intake-create')).toBeInTheDocument();
  });

  it('an incomplete zero-row terminal page (a first-page context-list fault) offers retry, not the terminal empty state', async () => {
    const user = userEvent.setup();
    const getTriggerFailures = vi
      .fn()
      .mockResolvedValueOnce({
        data: [], nextCursor: null, incomplete: true, contextsNotSearched: [], contextListUnavailable: false,
      })
      .mockResolvedValueOnce({
        data: [SAMPLE_ROWS[0]], nextCursor: null, incomplete: false, contextsNotSearched: [], contextListUnavailable: false,
      });
    const devApi = makeMockDevApi({ getTriggerFailures });
    renderPage({ devApi });
    await clickFetch(user);

    expect(await screen.findByText(/couldn't complete this search/i)).toBeInTheDocument();
    expect(screen.queryByText(/no trigger failures found/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^retry$/i }));
    expect(await screen.findByText('on-intake-create')).toBeInTheDocument();
  });

  it('contextListUnavailable drives distinct copy from a general incomplete search, in both the retry state and the banner', async () => {
    const user = userEvent.setup();
    const devApi = makeMockDevApi({
      getTriggerFailures: vi.fn().mockResolvedValue({
        data: [], nextCursor: null, incomplete: true, contextsNotSearched: [], contextListUnavailable: true,
      }),
    });
    renderPage({ devApi });
    await clickFetch(user);
    // Both the persistent status banner and the retry-state body use the SAME distinct copy here (by
    // design — the banner is a persistent indicator, the retry section is the actionable CTA) — assert
    // at least one match exists, not exactly one.
    expect((await screen.findAllByText(/couldn't load the list of app contexts/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/couldn't complete this search/i)).not.toBeInTheDocument();
  });

  it('surfaces a context-list failure instead of leaving the selector silently empty', async () => {
    const devApi = makeMockDevApi();
    devApi.listAppContexts = vi.fn().mockRejectedValue(new Error('contexts down'));
    renderPage({ devApi });
    expect(await screen.findByText(/couldn't load your app contexts/i)).toBeInTheDocument();
  });
});
