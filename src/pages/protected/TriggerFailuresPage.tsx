// ---------------------------------------------------------------------------
// TriggerFailuresPage — account-wide trigger execution failures.
//
// Functional scope:
//   - Answer "what automation has stopped running, and why" across the WHOLE
//     account — every app context, not one. A context-pinned bearer can only
//     ever see one context's failures, which is why this rides the owner-gated
//     developer API instead of the SDK's context-scoped surface.
//   - Optional narrowers: a single app context, a rule id, a category, a
//     retryable tri-state, and a time window. All optional — Fetch works with
//     none of them set, unlike the Disclosures page's required subject axis.
//   - Cursor pagination: the result is a `{ data, nextCursor }` page, PLUS
//     `incomplete`/`contextsNotSearched`. A context this page could not read
//     (a transient fault) is named explicitly — an honest gap must never read
//     as "nothing failed", so the warning banner below is always shown when
//     any loaded page reported one.
//   - Results are newest-first WITHIN a context; contexts are walked in a
//     fixed order, not merged into one account-wide timeline — a resumable
//     cursor whose size does not grow with the account's context count. The
//     idle/subtitle copy says so, so an operator doesn't read the list order
//     as "most recent failure anywhere, first".
//   - Re-running: Refresh, or Fetch with unchanged filters, re-queries from
//     the FIRST page via resetQueries — never `refetch()`, which re-fetches
//     every loaded page of an infinite query, not just the latest.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { FormattedMessage, useIntl } from 'react-intl';
import { hashKey, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiErrorAlert, LoadingBlock, SubmitButton } from '@vectros-ai/react';

import { useActiveTenantId } from '../../auth';
import { VectrosError } from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type {
  AppContextSummary,
  TriggerFailureEntry,
  TriggerFailuresResponse,
} from '../../api/developerApi';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';

/** '' selects every context — the account-wide default. */
const ALL_CONTEXTS = '';

/** Tri-state for the retryable filter. `any` omits the filter from the request. */
type RetryableFilter = 'any' | 'retryable' | 'not-retryable';

/** Page size requested per fetch (the server's hard cap is 100). */
const PAGE_LIMIT = 50;

/** Convert a datetime-local string (local time) to an ISO-8601 UTC string. */
function localDateTimeToIsoUtc(localDateTimeStr: string): string {
  return new Date(localDateTimeStr).toISOString();
}

/**
 * The query form's state — split into `pendingFilters` (what the operator is
 * editing) and `appliedFilters` (what the active query is keyed on, `null`
 * until the first Fetch). Every field is optional, unlike Disclosures' subject
 * axis, so the idle state is "account-wide, no filters" rather than blocked.
 */
interface TriggerFailureFilters {
  /** '' = every context (ALL_CONTEXTS). */
  readonly contextId: string;
  readonly ruleId: string;
  readonly category: string;
  readonly retryable: RetryableFilter;
  readonly from: string;
  readonly to: string;
}

function defaultPendingFilters(): TriggerFailureFilters {
  return {
    contextId: ALL_CONTEXTS,
    ruleId: '',
    category: '',
    retryable: 'any',
    from: '',
    to: '',
  };
}

function buildApiRequest(filters: TriggerFailureFilters): {
  contextId?: string;
  ruleId?: string;
  category?: string;
  retryable?: boolean;
  from?: string;
  to?: string;
  limit: number;
} {
  return {
    ...(filters.contextId ? { contextId: filters.contextId } : {}),
    ...(filters.ruleId.trim() ? { ruleId: filters.ruleId.trim() } : {}),
    ...(filters.category.trim() ? { category: filters.category.trim() } : {}),
    ...(filters.retryable === 'retryable'
      ? { retryable: true }
      : filters.retryable === 'not-retryable'
        ? { retryable: false }
        : {}),
    ...(filters.from ? { from: localDateTimeToIsoUtc(filters.from) } : {}),
    ...(filters.to ? { to: localDateTimeToIsoUtc(filters.to) } : {}),
    limit: PAGE_LIMIT,
  };
}

/** Retryable chip — retryable is a quiet neutral pill; not-retryable is the
 *  actionable signal (nothing will fix this without the operator). */
function RetryableChip({ retryable }: { retryable: boolean | undefined }): React.JSX.Element {
  if (retryable) {
    return (
      <Typography component="span" variant="body2" color="text.disabled">
        <FormattedMessage id="triggerFailures.retryableYes" />
      </Typography>
    );
  }
  return (
    <Chip
      label={<FormattedMessage id="triggerFailures.retryableNoValue" />}
      size="small"
      color="warning"
      variant="outlined"
      sx={{ fontWeight: 600 }}
    />
  );
}

export function TriggerFailuresPage(): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const queryClient = useQueryClient();

  const [pendingFilters, setPendingFilters] = useState<TriggerFailureFilters>(
    defaultPendingFilters,
  );
  const [appliedFilters, setAppliedFilters] = useState<TriggerFailureFilters | null>(null);

  // Load the account's app contexts to populate the OPTIONAL context selector.
  // Same source + cache key the other developer-API pages use. Best-effort: a
  // failure leaves the selector on "All contexts" only — Fetch still works.
  const devApi = useDeveloperApi();
  const contextsQuery = useQuery({
    queryKey: accessQueryKeys.appContexts(),
    queryFn: () =>
      drainPages<AppContextSummary>((startFrom) =>
        devApi.listAppContexts(startFrom, AUTH_PAGE_SIZE),
      ),
  });
  const contexts = useMemo<AppContextSummary[]>(
    () => contextsQuery.data ?? [],
    [contextsQuery.data],
  );

  const timeRangeInvalid = useMemo<boolean>(() => {
    if (!pendingFilters.from || !pendingFilters.to) return false;
    return (
      new Date(pendingFilters.from).getTime() >= new Date(pendingFilters.to).getTime()
    );
  }, [pendingFilters.from, pendingFilters.to]);
  const applyDisabled = timeRangeInvalid;

  const queryKeyFor = (filters: TriggerFailureFilters | null) =>
    ['triggerFailures', tenant, filters] as const;
  const queryKey = queryKeyFor(appliedFilters);
  const failuresQuery = useInfiniteQuery<TriggerFailuresResponse>({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      if (appliedFilters === null) {
        // Guarded by `enabled`; unreachable but satisfies the type checker.
        return Promise.reject(new Error('No applied filters'));
      }
      const startFrom = pageParam as string | undefined;
      return devApi.getTriggerFailures({
        ...buildApiRequest(appliedFilters),
        ...(startFrom ? { startFrom } : {}),
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: appliedFilters !== null,
    // An infinite query's AUTOMATIC refetches re-fetch every loaded page,
    // exactly like refetch() — a result set nobody is showing is dropped at
    // once instead, and nothing refetches on reconnect or focus. An explicit
    // re-run goes through rerunFromFirstPage.
    gcTime: 0,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const pages = useMemo(() => failuresQuery.data?.pages ?? [], [failuresQuery.data]);
  const rows: TriggerFailureEntry[] = useMemo(() => pages.flatMap((p) => p.data ?? []), [pages]);
  const loaded = failuresQuery.data !== undefined;

  // Aggregated across every loaded page — a context named "not searched" on
  // page 2 must stay visible after "Load more", not vanish because only the
  // latest page's flag is read.
  const incomplete = useMemo(() => pages.some((p) => p.incomplete), [pages]);
  const contextsNotSearched = useMemo(
    () => Array.from(new Set(pages.flatMap((p) => p.contextsNotSearched ?? []))),
    [pages],
  );
  const contextListUnavailable = useMemo(
    () => pages.some((p) => p.contextListUnavailable),
    [pages],
  );

  const loadErrorMessage = failuresQuery.isError
    ? intl.formatMessage(
        { id: 'triggerFailures.loadError' },
        {
          message:
            failuresQuery.error instanceof VectrosError
              ? failuresQuery.error.message
              : String(failuresQuery.error),
        },
      )
    : null;

  // ---- handlers ---------------------------------------------------------

  const commitFilter = <K extends keyof TriggerFailureFilters>(
    field: K,
    value: TriggerFailureFilters[K],
  ): void => {
    setPendingFilters((prev) => ({ ...prev, [field]: value }));
    setAppliedFilters((prev) =>
      prev === null ? null : ({ ...prev, [field]: value } as TriggerFailureFilters),
    );
  };

  /** Re-run the applied query from its FIRST page via resetQueries — never refetch(), which
   *  re-fetches every loaded page of an infinite query, not just the latest. */
  const rerunFromFirstPage = (): void => {
    void queryClient.resetQueries({ queryKey, exact: true });
  };

  const handleApply = (): void => {
    if (applyDisabled) return;
    if (
      appliedFilters !== null &&
      hashKey(queryKeyFor(pendingFilters)) === hashKey(queryKey)
    ) {
      if (!failuresQuery.isFetching) rerunFromFirstPage();
      return;
    }
    setAppliedFilters(pendingFilters);
  };

  // ---- render -----------------------------------------------------------

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
          <FormattedMessage id="triggerFailures.title" />
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
          <FormattedMessage id="triggerFailures.subtitle" />
        </Typography>
      </Box>

      {incomplete && (
        <Alert severity="warning" icon={<WarningAmberIcon />} role="alert">
          <AlertTitle>
            <FormattedMessage id="triggerFailures.incompleteWarning" />
          </AlertTitle>
          {contextsNotSearched.length > 0 ? (
            <FormattedMessage
              id="triggerFailures.incompleteContexts"
              values={{ contexts: contextsNotSearched.join(', ') }}
            />
          ) : contextListUnavailable ? (
            <FormattedMessage id="triggerFailures.contextListUnavailable" />
          ) : (
            <FormattedMessage id="triggerFailures.incompletePartialPage" />
          )}
        </Alert>
      )}

      <Paper component="section" aria-labelledby="trigger-failures-filter-heading" sx={{ p: 2.5 }}>
        <Typography
          id="trigger-failures-filter-heading"
          variant="h6"
          component="h2"
          sx={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
          }}
        >
          <FormattedMessage id="triggerFailures.filtersLegend" />
        </Typography>

        <Stack spacing={2}>
          <Stack direction="row" spacing={1.5} alignItems="flex-start" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 190 }}>
              <InputLabel id="trigger-failures-context-label">
                <FormattedMessage id="triggerFailures.contextLabel" />
              </InputLabel>
              <Select
                labelId="trigger-failures-context-label"
                label={intl.formatMessage({ id: 'triggerFailures.contextLabel' })}
                value={pendingFilters.contextId}
                onChange={(e) => commitFilter('contextId', e.target.value)}
                disabled={contextsQuery.isLoading || contextsQuery.isError}
              >
                <MenuItem value={ALL_CONTEXTS}>
                  <em>
                    <FormattedMessage id="triggerFailures.allContexts" />
                  </em>
                </MenuItem>
                {contexts.map((c) => (
                  <MenuItem key={c.contextId ?? ''} value={c.contextId ?? ''}>
                    {c.contextId}
                  </MenuItem>
                ))}
              </Select>
              {contextsQuery.isError && (
                <ApiErrorAlert error={contextsQuery.error}>
                  <FormattedMessage id="triggerFailures.contextsLoadError" />
                </ApiErrorAlert>
              )}
            </FormControl>

            <TextField
              size="small"
              label={intl.formatMessage({ id: 'triggerFailures.ruleIdLabel' })}
              value={pendingFilters.ruleId}
              onChange={(e) => setPendingFilters((prev) => ({ ...prev, ruleId: e.target.value }))}
              sx={{ minWidth: 200 }}
              inputProps={{ spellCheck: false }}
            />

            <TextField
              size="small"
              label={intl.formatMessage({ id: 'triggerFailures.categoryLabel' })}
              value={pendingFilters.category}
              onChange={(e) =>
                setPendingFilters((prev) => ({ ...prev, category: e.target.value }))
              }
              sx={{ minWidth: 180 }}
              inputProps={{ spellCheck: false }}
            />
          </Stack>

          <Divider />

          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={pendingFilters.retryable}
              onChange={(_, value: RetryableFilter | null) => {
                if (value != null) commitFilter('retryable', value);
              }}
              aria-label={intl.formatMessage({ id: 'triggerFailures.retryableLabel' })}
            >
              <ToggleButton value="any" sx={{ minWidth: 0, px: 1.5 }}>
                <FormattedMessage id="triggerFailures.retryableAny" />
              </ToggleButton>
              <ToggleButton value="retryable" sx={{ minWidth: 0, px: 1.5 }}>
                <FormattedMessage id="triggerFailures.retryableOnly" />
              </ToggleButton>
              <ToggleButton value="not-retryable" sx={{ minWidth: 0, px: 1.5 }}>
                <FormattedMessage id="triggerFailures.retryableNo" />
              </ToggleButton>
            </ToggleButtonGroup>

            <TextField
              size="small"
              type="datetime-local"
              label={intl.formatMessage({ id: 'triggerFailures.fromLabel' })}
              value={pendingFilters.from}
              onChange={(e) => setPendingFilters((prev) => ({ ...prev, from: e.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 200 }}
              error={timeRangeInvalid}
            />
            <TextField
              size="small"
              type="datetime-local"
              label={intl.formatMessage({ id: 'triggerFailures.toLabel' })}
              value={pendingFilters.to}
              onChange={(e) => setPendingFilters((prev) => ({ ...prev, to: e.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 200 }}
              error={timeRangeInvalid}
            />

            <Box sx={{ flexGrow: 1 }} />

            <SubmitButton
              variant="contained"
              onClick={handleApply}
              disabled={applyDisabled}
              pending={failuresQuery.isFetching && !failuresQuery.isFetchingNextPage}
              startIcon={<SearchIcon />}
              sx={{ height: 40 }}
            >
              {failuresQuery.isFetching && !failuresQuery.isFetchingNextPage ? (
                <FormattedMessage id="triggerFailures.fetchInFlight" />
              ) : (
                <FormattedMessage id="triggerFailures.fetchCta" />
              )}
            </SubmitButton>

            <Button
              variant="outlined"
              onClick={rerunFromFirstPage}
              disabled={appliedFilters === null || failuresQuery.isFetching}
              startIcon={<RefreshIcon />}
              sx={{ height: 40 }}
            >
              <FormattedMessage id="triggerFailures.refresh" />
            </Button>
          </Stack>

          <Stack spacing={0.5}>
            {timeRangeInvalid && (
              <Typography variant="caption" color="error">
                <FormattedMessage id="triggerFailures.timeRangeInvalid" />
              </Typography>
            )}
            {loaded && !failuresQuery.isFetching && (
              <Typography variant="caption" color="text.secondary">
                <FormattedMessage id="triggerFailures.resultSummary" values={{ count: rows.length }} />
              </Typography>
            )}
          </Stack>
        </Stack>
      </Paper>

      {loadErrorMessage && (
        <ApiErrorAlert error={failuresQuery.error}>{loadErrorMessage}</ApiErrorAlert>
      )}

      {appliedFilters === null && !loadErrorMessage && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage id="triggerFailures.idle" />
          </Typography>
        </Paper>
      )}

      {appliedFilters !== null &&
        !loaded &&
        !loadErrorMessage &&
        failuresQuery.isFetching && (
          <LoadingBlock label={intl.formatMessage({ id: 'triggerFailures.loading' })} />
        )}

      {/* Each request does a BOUNDED amount of work, so a page can come back with zero rows while
          more of the account is still unsearched (nextCursor present). That must not read as
          "nothing failed" — distinct copy + its own Load more, never the terminal empty state. */}
      {loaded && rows.length === 0 && !loadErrorMessage && failuresQuery.hasNextPage && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
            <FormattedMessage id="triggerFailures.emptyPageMoreToSearch" />
          </Typography>
          <Button
            variant="outlined"
            onClick={() => void failuresQuery.fetchNextPage()}
            disabled={failuresQuery.isFetchingNextPage}
          >
            {failuresQuery.isFetchingNextPage ? (
              <FormattedMessage id="triggerFailures.loadingMore" />
            ) : (
              <FormattedMessage id="triggerFailures.loadMore" />
            )}
          </Button>
        </Paper>
      )}

      {/* A page can terminate (no more cursor) while STILL incomplete — a context-list fault on the
          very first page, or every context faulting, both give zero rows + no cursor + incomplete.
          That is not the same claim as "nothing failed" and must not render as the terminal empty
          state: gate the terminal state on !incomplete, and offer a retry instead. */}
      {loaded && rows.length === 0 && !loadErrorMessage && !failuresQuery.hasNextPage && incomplete && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
            <FormattedMessage
              id={
                contextListUnavailable
                  ? 'triggerFailures.contextListUnavailable'
                  : 'triggerFailures.searchFailed'
              }
            />
          </Typography>
          <Button
            variant="outlined"
            onClick={rerunFromFirstPage}
            disabled={failuresQuery.isFetching}
            startIcon={<RefreshIcon />}
          >
            <FormattedMessage id="triggerFailures.retry" />
          </Button>
        </Paper>
      )}

      {loaded && rows.length === 0 && !loadErrorMessage && !failuresQuery.hasNextPage && !incomplete && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
            <FormattedMessage id="triggerFailures.empty" />
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ maxWidth: 560, mx: 'auto' }}>
            <FormattedMessage id="triggerFailures.emptyHint" />
          </Typography>
        </Paper>
      )}

      {rows.length > 0 && (
        <Box>
          <TableContainer component={Paper}>
            <Table
              size="small"
              aria-label={intl.formatMessage({ id: 'triggerFailures.tableLabel' })}
              sx={{ tableLayout: 'fixed' }}
            >
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 170, fontWeight: 600 }}>
                    <FormattedMessage id="triggerFailures.columnTime" />
                  </TableCell>
                  <TableCell sx={{ width: 130, fontWeight: 600 }}>
                    <FormattedMessage id="triggerFailures.columnContext" />
                  </TableCell>
                  <TableCell sx={{ width: 150, fontWeight: 600 }}>
                    <FormattedMessage id="triggerFailures.columnRule" />
                  </TableCell>
                  <TableCell sx={{ width: 140, fontWeight: 600 }}>
                    <FormattedMessage id="triggerFailures.columnCategory" />
                  </TableCell>
                  <TableCell sx={{ width: 100, fontWeight: 600 }}>
                    <FormattedMessage id="triggerFailures.columnRetryable" />
                  </TableCell>
                  <TableCell sx={{ width: 90, fontWeight: 600 }}>
                    <FormattedMessage id="triggerFailures.columnAttempts" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="triggerFailures.columnDetail" />
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, i) => (
                  <TriggerFailureTableRow key={row.id ?? `${row.createdAt}-${i}`} row={row} />
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {failuresQuery.hasNextPage && (
            <Stack direction="row" justifyContent="center" sx={{ mt: 2 }}>
              <Button
                variant="outlined"
                onClick={() => void failuresQuery.fetchNextPage()}
                disabled={failuresQuery.isFetchingNextPage}
              >
                {failuresQuery.isFetchingNextPage ? (
                  <FormattedMessage id="triggerFailures.loadingMore" />
                ) : (
                  <FormattedMessage id="triggerFailures.loadMore" />
                )}
              </Button>
            </Stack>
          )}
        </Box>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// TriggerFailureTableRow — one row, extracted to keep the main return shallow.
// ---------------------------------------------------------------------------

function TriggerFailureTableRow({
  row,
}: {
  row: TriggerFailureEntry;
}): React.JSX.Element {
  const intl = useIntl();
  const emDash = intl.formatMessage({ id: 'triggerFailures.cellEmpty' });
  // INTERNAL_ERROR carries a correlationId instead of a detail message — quote
  // it to support, per the partner-facing endpoint's own documented contract.
  const detailCell = row.detail
    ? row.detail
    : row.correlationId
      ? `${row.correlationId} (${intl.formatMessage({ id: 'triggerFailures.internalErrorHint' })})`
      : emDash;

  return (
    <TableRow hover>
      <TableCell>
        {row.createdAt ? (
          <Tooltip title={row.createdAt}>
            <span>
              {intl.formatDate(row.createdAt, {
                dateStyle: 'medium',
                timeStyle: 'medium',
              })}
            </span>
          </Tooltip>
        ) : (
          emDash
        )}
      </TableCell>
      <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.contextId || emDash}
      </TableCell>
      <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.ruleName || row.ruleId || emDash}
      </TableCell>
      <TableCell>{row.category || emDash}</TableCell>
      <TableCell>
        <RetryableChip retryable={row.retryable} />
      </TableCell>
      <TableCell>{row.attempts ?? emDash}</TableCell>
      <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <Tooltip title={detailCell}>
          <span>{detailCell}</span>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}
