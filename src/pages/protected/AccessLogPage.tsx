// ---------------------------------------------------------------------------
// AccessLogPage — the accounting-of-disclosures surface.
//
// Functional scope:
//   - Answer the core HIPAA §164.528 question for one data subject: "who read
//     this patient's / subject's protected data, when, which action, and was
//     any sensitive value actually revealed in plaintext?" The query is
//     deliberately SUBJECT-SCOPED — you enter a subject within a context and
//     get that subject's disclosure history, not a firehose of every read.
//   - Required axes: an app context + a subject (type + id). Optional narrowers:
//     a nested client/patient, a single action, a revealed-sensitive filter,
//     and a time window. Metadata only — the payload, the looked-up value, and
//     any query text are never recorded, so they are never shown here.
//   - `revealedSensitive` is a first-class column: it is true only when at
//     least one sensitive field was actually returned unmasked, which is
//     materially different from a masked read for accounting purposes.
//   - Cursor pagination: the result is a `{ data, nextCursor }` page. "Load
//     more" follows the cursor. We never silently drain or silently truncate —
//     the operator sees exactly what has loaded and can ask for more.
//
// Coverage caveat (critical — see the standing info banner):
//   Read-access logging is OPT-IN and off by default (per schema, with a
//   context-level default). When it is not enabled for a context or record
//   type, reads of that data are not recorded at all — so an EMPTY result does
//   NOT prove "no one accessed this subject." The UI states this explicitly so
//   an empty table is never mistaken for a clean bill of access. This surface
//   shows the RAW record of every logged read; classifying which reads are
//   accountable disclosures (vs. exempt treatment / payment / operations reads)
//   is the covered entity's compliance determination, not something this view
//   adjudicates.
//
// Data path: the query is the partner API's owner-gated `getAccessLog`
// (`access-log:r` scope; an account owner's token carries it). Because the
// query is scoped to a single context, it is issued with a bearer minted for
// THAT context — `vectrosApiClient(tenant, contextId)` — mirroring the other
// context-scoped pages. The context list itself is tenant-wide, so it comes
// from the owner-gated developer API (as on the Activity Logs page).
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
import SearchIcon from '@mui/icons-material/Search';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { FormattedMessage, useIntl } from 'react-intl';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ApiErrorAlert, LoadingBlock, SubmitButton } from '@vectros-ai/react';

import { useActiveTenantId } from '../../auth';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type { GetAccessLogRequest, ReadAccessLogPage, ReadAccessLogRow } from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type { AppContextSummary } from '../../api/developerApi';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';

// ---------------------------------------------------------------------------
// Constants — mirror the server's accepted subject types + actions. Out-of-list
// values are rejected with 400, so keeping these aligned avoids a round-trip to
// discover an invalid pick. There is no automated frontend-drift check today.
// ---------------------------------------------------------------------------

/** Subject kinds the accounting query accepts. */
const SUBJECT_TYPES = ['user', 'client', 'org'] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

/** Actions a logged read can carry. `''` = all actions. */
const ACTIONS = ['read', 'list', 'lookup', 'search', 'rag'] as const;
type Action = (typeof ACTIONS)[number];

/** Tri-state for the revealed-sensitive filter. `any` omits the filter from the
 *  request; `revealed`/`masked` send `revealedSensitive` true/false. */
type RevealedFilter = 'any' | 'revealed' | 'masked';

/** Page size requested per fetch (the server's hard cap is 500). */
const PAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Time helpers — `<input type="datetime-local">` yields a LOCAL-time string in
// `YYYY-MM-DDTHH:MM` shape (no zone, no seconds); the API wants ISO-8601 UTC.
// We convert at the boundary. (Same conversion the Activity Logs page uses.)
// ---------------------------------------------------------------------------

/** Convert a datetime-local string (local time) to an ISO-8601 UTC string. */
function localDateTimeToIsoUtc(localDateTimeStr: string): string {
  return new Date(localDateTimeStr).toISOString();
}

// ---------------------------------------------------------------------------
// Filter shape
// ---------------------------------------------------------------------------

/**
 * The query form's state, stored twice on the page:
 *   - `pendingFilters` — what the operator is currently editing.
 *   - `appliedFilters` — what the active query is keyed on; `null` until the
 *     first Fetch (the idle state).
 *
 * Splitting the two keeps the query stable across edits and makes the
 * "you've changed the form but haven't refetched" relationship visible. The
 * required identity fields (context + subject) only take effect on an explicit
 * Fetch so a half-typed subject id never fires a query; discrete filter picks
 * re-query immediately once the first fetch has run (see `commitFilters`).
 */
interface AccessLogFilters {
  /** App context to scope the query to (required). */
  readonly contextId: string;
  /** Subject kind (required). */
  readonly subjectType: SubjectType;
  /** Subject id whose disclosure history to return (required). */
  readonly subjectId: string;
  /** Single-action filter, or '' for all actions. */
  readonly action: Action | '';
  /** Revealed-sensitive filter. */
  readonly revealed: RevealedFilter;
  /** Start of window (datetime-local string), or '' for open-start. */
  readonly from: string;
  /** End of window (datetime-local string), or '' for open-end (now). */
  readonly to: string;
}

/** Initial pending filters — nothing selected; the operator picks a context +
 *  subject. `contextId` starts empty so the required-field gate holds Fetch. */
function defaultPendingFilters(): AccessLogFilters {
  return {
    contextId: '',
    subjectType: 'user',
    subjectId: '',
    action: '',
    revealed: 'any',
    from: '',
    to: '',
  };
}

/**
 * Build the SDK request from the applied filters. Empty optional fields are
 * omitted entirely (an absent query param differs from an empty one); the
 * `contextId` + subject axes are always present because the Fetch gate requires
 * them. The tenant is derived server-side from the caller's token, never sent.
 */
function buildApiRequest(filters: AccessLogFilters): GetAccessLogRequest {
  return {
    contextId: filters.contextId,
    subjectType: filters.subjectType,
    // Trimmed to match the Fetch gate (which trims before deciding "present")
    // and to avoid sending a trailing-space id the server would fail to match.
    subjectId: filters.subjectId.trim(),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.revealed === 'revealed'
      ? { revealedSensitive: true }
      : filters.revealed === 'masked'
        ? { revealedSensitive: false }
        : {}),
    ...(filters.from ? { from: localDateTimeToIsoUtc(filters.from) } : {}),
    ...(filters.to ? { to: localDateTimeToIsoUtc(filters.to) } : {}),
    limit: PAGE_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Cell render helpers — pure, no own state. Colors use MUI palette tokens so a
// partner fork inherits theme overrides rather than hardcoded hex.
// ---------------------------------------------------------------------------

/**
 * The reveal chip — the accounting-critical signal. A read that actually
 * returned a sensitive value unmasked is flagged in warning color; a masked
 * read is a quiet, muted "No". Never a saturated fill for the common case.
 */
function RevealedChip({ revealed }: { revealed: boolean | undefined }): React.JSX.Element {
  if (revealed) {
    return (
      <Chip
        icon={<VisibilityIcon sx={{ fontSize: 16 }} />}
        label={<FormattedMessage id="accessLog.revealedYes" />}
        size="small"
        color="warning"
        sx={{ fontWeight: 600 }}
      />
    );
  }
  return (
    <Typography component="span" variant="body2" color="text.disabled">
      <FormattedMessage id="accessLog.revealedNo" />
    </Typography>
  );
}

/** Action chip — a neutral, outlined pill (the action taxonomy is small). */
function ActionChip({ action }: { action: string | undefined }): React.JSX.Element {
  if (!action) {
    return (
      <Typography component="span" color="text.disabled">
        <FormattedMessage id="accessLog.cellEmpty" />
      </Typography>
    );
  }
  return (
    <Chip
      label={action}
      size="small"
      variant="outlined"
      sx={{ fontWeight: 500, color: 'text.secondary', borderColor: 'divider' }}
    />
  );
}

// ---------------------------------------------------------------------------
// AccessLogPage
// ---------------------------------------------------------------------------

export function AccessLogPage(): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();

  const [pendingFilters, setPendingFilters] = useState<AccessLogFilters>(
    defaultPendingFilters,
  );
  const [appliedFilters, setAppliedFilters] = useState<AccessLogFilters | null>(null);

  // Load the account's app contexts to populate the required context selector.
  // Owner-gated developer API (the only surface that enumerates every context),
  // the same source + cache key the Activity Logs / App Contexts pages use.
  // A failure leaves the selector empty and Fetch permanently gated, so it is
  // surfaced below rather than left to look like an empty account. (The drain
  // this uses refuses to return a partial list, so "empty" and "too large to
  // enumerate" are both real failures here, not just a slow load.)
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

  // Derived validation — purely from `pendingFilters`. Fetch stays disabled
  // until both required identity axes are present and the time window is sane.
  const timeRangeInvalid = useMemo<boolean>(() => {
    if (!pendingFilters.from || !pendingFilters.to) return false;
    return (
      new Date(pendingFilters.from).getTime() >= new Date(pendingFilters.to).getTime()
    );
  }, [pendingFilters.from, pendingFilters.to]);
  const missingRequired =
    pendingFilters.contextId === '' || pendingFilters.subjectId.trim() === '';
  const applyDisabled = missingRequired || timeRangeInvalid;

  // Cursor-paginated query. Keyed on the applied filters; each page follows the
  // previous page's `nextCursor` via `startFrom`. The bearer is minted for the
  // applied context so the query passes the server's context-binding check.
  const logQuery = useInfiniteQuery<ReadAccessLogPage>({
    queryKey: ['accessLog', tenant, appliedFilters] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      if (appliedFilters === null) {
        // Guarded by `enabled`; unreachable but satisfies the type checker.
        return Promise.reject(new Error('No applied filters'));
      }
      const startFrom = pageParam as string | undefined;
      return vectrosApiClient(tenant, appliedFilters.contextId).auth.getAccessLog({
        ...buildApiRequest(appliedFilters),
        ...(startFrom ? { startFrom } : {}),
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: appliedFilters !== null,
  });

  // Flatten the loaded pages. `data` is undefined until the first page resolves.
  const rows: ReadAccessLogRow[] = useMemo(
    () => (logQuery.data?.pages ?? []).flatMap((p) => p.data ?? []),
    [logQuery.data],
  );
  const loaded = logQuery.data !== undefined; // at least one page has resolved

  const loadErrorMessage = logQuery.isError
    ? intl.formatMessage(
        { id: 'accessLog.loadError' },
        {
          message:
            logQuery.error instanceof VectrosError
              ? logQuery.error.message
              : String(logQuery.error),
        },
      )
    : null;

  // ---- handlers ---------------------------------------------------------

  /**
   * Commit a single discrete control (context, subject type, action, revealed).
   * It updates the form, and — once an initial fetch has happened — re-queries
   * immediately so the pick takes effect without a second Fetch press. The
   * change is applied ONTO the last-applied query, NOT onto the whole pending
   * form, so an un-fetched free-text edit (a half-typed subject id, client id,
   * or time bound) never silently rides along and shifts the applied subject.
   * Before the first Fetch it only updates the pending form.
   */
  const commitFilter = <K extends keyof AccessLogFilters>(
    field: K,
    value: AccessLogFilters[K],
  ): void => {
    setPendingFilters((prev) => ({ ...prev, [field]: value }));
    setAppliedFilters((prev) =>
      prev === null ? null : ({ ...prev, [field]: value } as AccessLogFilters),
    );
  };

  const handleApply = (): void => {
    if (applyDisabled) return;
    setAppliedFilters(pendingFilters);
  };

  // The subject the loaded results describe (from the applied query, so it does
  // not shift while the operator edits the form before refetching).
  const appliedSubject = appliedFilters
    ? `${appliedFilters.subjectType}:${appliedFilters.subjectId}`
    : null;

  // ---- render -----------------------------------------------------------

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
          <FormattedMessage id="accessLog.title" />
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
          <FormattedMessage id="accessLog.subtitle" />
        </Typography>
      </Box>

      {/* Standing coverage caveat — the critical framing. Always visible so an
          empty table is never read as "no one accessed this subject". It is
          static guidance, not a live announcement, so it is a `note` rather
          than the MUI Alert default `role="alert"` (which is reserved for the
          error surface below). */}
      <Alert severity="info" icon={<VisibilityIcon />} role="note">
        <AlertTitle>
          <FormattedMessage id="accessLog.coverageTitle" />
        </AlertTitle>
        <FormattedMessage id="accessLog.coverageBody" />
      </Alert>

      {/* Query form. */}
      <Paper component="section" aria-labelledby="access-log-filter-heading" sx={{ p: 2.5 }}>
        <Typography
          id="access-log-filter-heading"
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
          <FormattedMessage id="accessLog.filtersLegend" />
        </Typography>

        <Stack spacing={2}>
          {/* Identity row — context + subject axes (all required). */}
          <Stack direction="row" spacing={1.5} alignItems="flex-start" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 190 }} required>
              <InputLabel id="access-log-context-label">
                <FormattedMessage id="accessLog.contextLabel" />
              </InputLabel>
              <Select
                labelId="access-log-context-label"
                label={intl.formatMessage({ id: 'accessLog.contextLabel' })}
                value={
                  contexts.some((c) => c.contextId === pendingFilters.contextId)
                    ? pendingFilters.contextId
                    : ''
                }
                onChange={(e) => commitFilter('contextId', e.target.value)}
                disabled={contextsQuery.isLoading || contextsQuery.isError}
              >
                {contexts.map((c) => (
                  <MenuItem key={c.contextId ?? ''} value={c.contextId ?? ''}>
                    {c.contextId}
                  </MenuItem>
                ))}
              </Select>
              {contextsQuery.isError && (
                <ApiErrorAlert error={contextsQuery.error}>
                  <FormattedMessage id="accessLog.contextsLoadError" />
                </ApiErrorAlert>
              )}
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 130 }} required>
              <InputLabel id="access-log-subject-type-label">
                <FormattedMessage id="accessLog.subjectTypeLabel" />
              </InputLabel>
              <Select
                labelId="access-log-subject-type-label"
                label={intl.formatMessage({ id: 'accessLog.subjectTypeLabel' })}
                value={pendingFilters.subjectType}
                onChange={(e) => commitFilter('subjectType', e.target.value as SubjectType)}
              >
                {SUBJECT_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              size="small"
              required
              label={intl.formatMessage({ id: 'accessLog.subjectIdLabel' })}
              value={pendingFilters.subjectId}
              onChange={(e) =>
                setPendingFilters((prev) => ({ ...prev, subjectId: e.target.value }))
              }
              sx={{ minWidth: 220 }}
              inputProps={{ spellCheck: false }}
            />
          </Stack>

          <Divider />

          {/* Filter row — action, revealed, time window, + the Fetch action. */}
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <InputLabel id="access-log-action-label">
                <FormattedMessage id="accessLog.actionLabel" />
              </InputLabel>
              <Select
                labelId="access-log-action-label"
                label={intl.formatMessage({ id: 'accessLog.actionLabel' })}
                value={pendingFilters.action}
                onChange={(e) => commitFilter('action', e.target.value as Action | '')}
              >
                <MenuItem value="">
                  <em>
                    <FormattedMessage id="accessLog.actionAll" />
                  </em>
                </MenuItem>
                {ACTIONS.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <ToggleButtonGroup
              exclusive
              size="small"
              value={pendingFilters.revealed}
              onChange={(_, value: RevealedFilter | null) => {
                if (value != null) commitFilter('revealed', value);
              }}
              aria-label={intl.formatMessage({ id: 'accessLog.revealedLegend' })}
            >
              <ToggleButton value="any" sx={{ minWidth: 0, px: 1.5 }}>
                <FormattedMessage id="accessLog.revealedAny" />
              </ToggleButton>
              <ToggleButton value="revealed" sx={{ minWidth: 0, px: 1.5 }}>
                <FormattedMessage id="accessLog.revealedOnly" />
              </ToggleButton>
              <ToggleButton value="masked" sx={{ minWidth: 0, px: 1.5 }}>
                <FormattedMessage id="accessLog.revealedMasked" />
              </ToggleButton>
            </ToggleButtonGroup>

            <TextField
              size="small"
              type="datetime-local"
              label={intl.formatMessage({ id: 'accessLog.fromLabel' })}
              value={pendingFilters.from}
              onChange={(e) => setPendingFilters((prev) => ({ ...prev, from: e.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 200 }}
              error={timeRangeInvalid}
            />
            <TextField
              size="small"
              type="datetime-local"
              label={intl.formatMessage({ id: 'accessLog.toLabel' })}
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
              pending={logQuery.isFetching && !logQuery.isFetchingNextPage}
              startIcon={<SearchIcon />}
              sx={{ height: 40 }}
            >
              {logQuery.isFetching && !logQuery.isFetchingNextPage ? (
                <FormattedMessage id="accessLog.fetchInFlight" />
              ) : (
                <FormattedMessage id="accessLog.fetchCta" />
              )}
            </SubmitButton>
          </Stack>

          {/* Validation + result summary, on their own line so they never
              disturb the row alignment. */}
          <Stack spacing={0.5}>
            {timeRangeInvalid && (
              <Typography variant="caption" color="error">
                <FormattedMessage id="accessLog.timeRangeInvalid" />
              </Typography>
            )}
            {loaded && !logQuery.isFetching && appliedSubject && (
              <Typography variant="caption" color="text.secondary">
                <FormattedMessage
                  id="accessLog.resultSummary"
                  values={{ count: rows.length, subject: appliedSubject }}
                />
              </Typography>
            )}
          </Stack>
        </Stack>
      </Paper>

      {/* Error state — friendly copy + the requestId for support. */}
      {loadErrorMessage && (
        <ApiErrorAlert error={logQuery.error}>{loadErrorMessage}</ApiErrorAlert>
      )}

      {/* Idle — before the first Fetch. */}
      {appliedFilters === null && !loadErrorMessage && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage id="accessLog.idle" />
          </Typography>
        </Paper>
      )}

      {/* Loading — first fetch in flight, no data yet. */}
      {appliedFilters !== null &&
        !loaded &&
        !loadErrorMessage &&
        logQuery.isFetching && (
          <LoadingBlock label={intl.formatMessage({ id: 'accessLog.loading' })} />
        )}

      {/* Empty — fetched successfully but no rows. The coverage caveat is
          repeated here because THIS is where a false "no access" reading is
          most tempting: an empty table must distinguish "no disclosures were
          recorded for this subject" from "logging was not enabled, so nothing
          could be recorded". */}
      {loaded && rows.length === 0 && !loadErrorMessage && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
            <FormattedMessage id="accessLog.empty" values={{ subject: appliedSubject }} />
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ maxWidth: 560, mx: 'auto' }}>
            <FormattedMessage id="accessLog.emptyHint" />
          </Typography>
        </Paper>
      )}

      {/* Results table. */}
      {rows.length > 0 && (
        <Box>
          <TableContainer component={Paper}>
            <Table
              size="small"
              aria-label={intl.formatMessage({ id: 'accessLog.tableLabel' })}
              sx={{ tableLayout: 'fixed' }}
            >
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 180, fontWeight: 600 }}>
                    <FormattedMessage id="accessLog.columnTime" />
                  </TableCell>
                  <TableCell sx={{ width: 100, fontWeight: 600 }}>
                    <FormattedMessage id="accessLog.columnAction" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="accessLog.columnResource" />
                  </TableCell>
                  <TableCell sx={{ width: 160, fontWeight: 600 }}>
                    <FormattedMessage id="accessLog.columnCaller" />
                  </TableCell>
                  <TableCell sx={{ width: 150, fontWeight: 600 }}>
                    <FormattedMessage id="accessLog.columnRevealed" />
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, i) => (
                  <AccessLogTableRow key={row.id ?? `${row.createdAt}-${i}`} row={row} />
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {/* Cursor pagination — explicit "Load more". We never silently drain
              (a subject's history can be long + billed) nor silently truncate. */}
          {logQuery.hasNextPage && (
            <Stack direction="row" justifyContent="center" sx={{ mt: 2 }}>
              <Button
                variant="outlined"
                onClick={() => void logQuery.fetchNextPage()}
                disabled={logQuery.isFetchingNextPage}
              >
                {logQuery.isFetchingNextPage ? (
                  <FormattedMessage id="accessLog.loadingMore" />
                ) : (
                  <FormattedMessage id="accessLog.loadMore" />
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
// AccessLogTableRow — one row, extracted to keep the main return shallow.
// ---------------------------------------------------------------------------

function AccessLogTableRow({ row }: { row: ReadAccessLogRow }): React.JSX.Element {
  const intl = useIntl();
  const emDash = intl.formatMessage({ id: 'accessLog.cellEmpty' });
  // "type:id" for the accessed resource; either half may be absent.
  const resource =
    row.resourceType || row.resourceId
      ? `${row.resourceType ?? ''}${row.resourceType && row.resourceId ? ':' : ''}${row.resourceId ?? ''}`
      : null;

  return (
    <TableRow sx={{ '&:hover': { bgcolor: 'action.hover' } }}>
      <TableCell
        sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}
      >
        {row.createdAt ? new Date(row.createdAt).toLocaleString() : emDash}
      </TableCell>
      <TableCell>
        <ActionChip action={row.action} />
      </TableCell>
      <TableCell
        sx={{
          fontFamily: 'monospace',
          fontSize: 12,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <Tooltip title={resource ?? ''}>
          <span>{resource ?? emDash}</span>
        </Tooltip>
      </TableCell>
      <TableCell
        sx={{
          fontFamily: 'monospace',
          fontSize: 11,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'text.secondary',
        }}
      >
        <Tooltip title={row.callerKeyId ?? ''}>
          <span>{row.callerKeyId ?? emDash}</span>
        </Tooltip>
      </TableCell>
      <TableCell>
        <RevealedChip revealed={row.revealedSensitive} />
      </TableCell>
    </TableRow>
  );
}
