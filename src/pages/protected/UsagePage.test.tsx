// ---------------------------------------------------------------------------
// UsagePage tests.
//
// Pinning:
//   1. Loading state while getUsage is in flight.
//   2. Renders the credit headline numbers, the category breakdown, read
//      metering, the live/test split, and the per-context table.
//   3. Unlimited plan (limit: null) renders as "Unlimited", not a dash.
//   4. Error alert on getUsage failure.
//   5. Refresh re-queries.
// ---------------------------------------------------------------------------

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { UsagePage } from './UsagePage';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return {
    ...actual,
    vectrosApiClient: vi.fn(),
  };
});

/** A representative usage report — real response shape (fields the page reads).
 *
 *  The breakdown categories SUM to `credits.used` on purpose: that is the property
 *  `reconciles the category breakdown against the headline total` asserts, and the
 *  one a category missing from BREAKDOWN_ROWS breaks. Keep it true when you add a
 *  category here. */
const SAMPLE_REPORT = {
  period: '2026-07',
  credits: {
    used: 49,
    limit: 1000,
    remaining: 951,
    breakdown: {
      searchQueries: 12,
      searchIngest: 9,
      documents: 3,
      records: 8,
      identity: 1,
      storageEstimate: 5,
      reads: 2,
      dataOut: 2,
      scriptExecution: 7,
    },
  },
  reads: {
    calls: { used: 1500, freeAllowance: 10000, overage: 0, overageCredits: 0 },
    dataOut: { bytes: 52_400_000, freeBytes: 100_000_000, overageBytes: 0, overageCredits: 0 },
  },
  tenants: {
    live: { id: 'tnt_live_001', credits: { used: 37 } },
    test: { id: 'tnt_test_001', credits: { used: 12 } },
  },
  contexts: [
    { contextId: 'default', tenantId: 'tnt_live_001', tenantMode: 'live', credits: { used: 25 } },
    { contextId: 'staging-eval', tenantId: 'tnt_test_001', tenantMode: 'test', credits: { used: 12 } },
  ],
};

function renderPage(getUsage: ReturnType<typeof vi.fn>) {
  vi.mocked(vectrosApiClient).mockReturnValue({ auth: { getUsage } } as never);
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <TestTenantProvider>
          <UsagePage />
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

describe('UsagePage', () => {
  beforeEach(() => vi.mocked(vectrosApiClient).mockReset());

  it('shows a loading state while the report is in flight', () => {
    renderPage(vi.fn(() => new Promise(() => undefined)));
    // LoadingBlock renders a spinner whose accessible name is the label.
    expect(screen.getByRole('progressbar', { name: /loading usage/i })).toBeInTheDocument();
  });

  it('renders credits, breakdown, read metering, environments, and contexts', async () => {
    renderPage(vi.fn().mockResolvedValue(SAMPLE_REPORT));

    // Headline credit numbers + the billing period chip.
    expect(await screen.findByText('2026-07')).toBeInTheDocument();
    expect(screen.getByText('49')).toBeInTheDocument();
    expect(screen.getByText('1,000')).toBeInTheDocument();
    expect(screen.getByText('951')).toBeInTheDocument();

    // Category breakdown rows.
    const breakdown = screen.getByRole('table', { name: /credit breakdown/i });
    expect(within(breakdown).getByText('Search queries')).toBeInTheDocument();
    expect(within(breakdown).getByText('12')).toBeInTheDocument();
    expect(within(breakdown).getByText('Storage (estimate)')).toBeInTheDocument();

    // Read metering — both axes; bytes humanized.
    const reads = screen.getByRole('table', { name: /read metering/i });
    expect(within(reads).getByText('Read calls')).toBeInTheDocument();
    expect(within(reads).getByText('1,500')).toBeInTheDocument();
    expect(within(reads).getByText('52.4 MB')).toBeInTheDocument();

    // Live/test split.
    const envs = screen.getByRole('table', { name: /usage by environment/i });
    expect(within(envs).getByText('Live')).toBeInTheDocument();
    expect(within(envs).getByText('37')).toBeInTheDocument();
    expect(within(envs).getByText('Test')).toBeInTheDocument();

    // Per-context attribution.
    const contexts = screen.getByRole('table', { name: /usage by app context/i });
    expect(within(contexts).getByText('default')).toBeInTheDocument();
    expect(within(contexts).getByText('staging-eval')).toBeInTheDocument();
  });

  // Proves the nine categories the API reports today all RENDER, and that they add
  // up to the headline.
  //
  // ⚠️ It does NOT catch a category neither this fixture nor BREAKDOWN_ROWS has
  // learned about — both are hand-maintained in the repo, so a new API category is
  // absent from both and this stays green. An earlier comment here claimed
  // otherwise. That gap is closed at COMPILE time instead, by
  // `_breakdownRowsAreExhaustive` in UsagePage.tsx, which checks the row list
  // against the SDK's own `CreditBreakdown` type.
  it('reconciles the category breakdown against the headline total', async () => {
    renderPage(vi.fn().mockResolvedValue(SAMPLE_REPORT));

    const breakdown = await screen.findByRole('table', { name: /credit breakdown/i });
    const rendered = within(breakdown)
      .getAllByRole('row')
      .map((row) => row.querySelectorAll('td')[1]?.textContent?.trim())
      .filter((cell): cell is string => cell !== undefined && cell !== '')
      // Cells render through `FormattedNumber`, so anything >= 1000 arrives
      // group-separated — a bare `Number()` would read `1,234` as NaN and silently
      // drop the row from the sum, which is precisely the reconciliation this
      // asserts. Strip separators before parsing.
      .map((cell) => Number(cell.replace(/[^0-9.-]/g, '')))
      .filter((n) => !Number.isNaN(n));

    const total = rendered.reduce((sum, n) => sum + n, 0);
    expect(total).toBe(SAMPLE_REPORT.credits.used);
    // Every category the API reported must be one of the rows we just summed.
    expect(rendered).toHaveLength(Object.keys(SAMPLE_REPORT.credits.breakdown).length);
  });

  it('itemises the script execution charge WITHOUT calling it trigger-only', async () => {
    renderPage(vi.fn().mockResolvedValue(SAMPLE_REPORT));

    const breakdown = await screen.findByRole('table', { name: /credit breakdown/i });
    expect(within(breakdown).getByText('Script execution time')).toBeInTheDocument();
    expect(within(breakdown).getByText('7')).toBeInTheDocument();
    // The figure covers trigger firings AND synchronous script-execution calls
    // together, so an account that runs no triggers can still be charged on this
    // row. Labelling it "Trigger script execution time" told that account its
    // charge came from something it does not use.
    expect(within(breakdown).queryByText(/trigger/i)).not.toBeInTheDocument();
  });

  it('renders a null plan limit as Unlimited', async () => {
    renderPage(
      vi.fn().mockResolvedValue({
        ...SAMPLE_REPORT,
        credits: { ...SAMPLE_REPORT.credits, limit: null, remaining: null },
      }),
    );

    expect(await screen.findByText('49')).toBeInTheDocument();
    // Both the limit and remaining slots say Unlimited on an unlimited plan.
    expect(screen.getAllByText('Unlimited')).toHaveLength(2);
  });

  it('does not show the context-confinement notice for a cross-context credential (both environments populated)', async () => {
    renderPage(vi.fn().mockResolvedValue(SAMPLE_REPORT));

    await screen.findByText('2026-07');
    expect(screen.queryByText(/confined to a single app context/i)).not.toBeInTheDocument();
  });

  it('shows the context-confinement notice when one environment is null (0.40.0)', async () => {
    renderPage(
      vi.fn().mockResolvedValue({
        ...SAMPLE_REPORT,
        reads: {
          calls: { used: 0, freeAllowance: 10000, overage: 0, overageCredits: 0 },
          dataOut: { bytes: 0, freeBytes: 100_000_000, overageBytes: 0, overageCredits: 0 },
        },
        tenants: { live: SAMPLE_REPORT.tenants.live, test: null },
      }),
    );

    await screen.findByText('2026-07');
    expect(screen.getByText(/confined to a single app context/i)).toBeInTheDocument();
  });

  it('shows the error alert when the report fails to load', async () => {
    renderPage(
      vi.fn().mockRejectedValue(
        new VectrosError({ statusCode: 500, body: { message: 'boom' } }),
      ),
    );

    expect(await screen.findByText(/couldn't load the usage report/i)).toBeInTheDocument();
  });

  it('refresh re-queries the report', async () => {
    const user = userEvent.setup();
    const getUsage = vi.fn().mockResolvedValue(SAMPLE_REPORT);
    renderPage(getUsage);

    await screen.findByText('2026-07');
    const before = getUsage.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(getUsage.mock.calls.length).toBeGreaterThan(before));
  });
});
