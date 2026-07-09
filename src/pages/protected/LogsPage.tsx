// ---------------------------------------------------------------------------
// LogsPage — admin-app's Activity Logs surface.
//
// Functional scope:
//   - Read the account activity log via the owner-gated Developer API. The
//     endpoint reads CloudWatch Logs Insights for request-completion log lines;
//     request and response bodies are never logged (only metadata: method /
//     path / status / duration / key id / context). Tenant-wide by default —
//     every app context — with an optional single-context filter.
//   - Time-range presets (30m, 1h, 6h, 24h) + custom datetime-local pickers.
//   - Resource + method allow-list filters (mirror of the server's accepted
//     resource / method values; out-of-list values are rejected with 400).
//   - Optional keyId filter for debugging a specific scoped key's traffic
//     (admin debugging — surfaces "what did key X just do?" without combing
//     CloudWatch by hand).
//   - Errors-only toggle (status >= 400).
//   - "Fetch logs" button — the first query is gated on an explicit user
//     action rather than firing on mount. CloudWatch Logs Insights is metered
//     and can take seconds for large windows, so auto-fetch-on-mount would
//     surprise. Refresh re-fetches with the last-applied filters.
//   - Truncation banner when `data.truncated === true`. The endpoint has NO
//     cursor pagination by design: "load older" UX is narrower time windows,
//     not next-page tokens.
//
// Built on TanStack Query. One `useQuery` keyed on
// `['adminLogs', tenant, appliedFilters]` — applied filters are a snapshot
// taken when the user clicks Fetch, distinct from `pendingFilters` (the
// in-progress form state). Updating the filter form does NOT trigger a
// refetch; the user commits via Fetch / Refresh.
//
// Tenant resolution: the Developer API resolves the account (its tenant + every
//   context) from the account owner's session server-side; the client sends only
//   the live/test selector. `useActiveTenantId()` is still used to namespace the
//   query cache per active environment.
//
// Interaction model (mirrors the developer portal's logs page): the first
// query is gated on an explicit Fetch (CloudWatch Logs Insights is metered),
// but once a fetch has happened, a discrete filter pick — a preset, the
// resource / method selector, or the errors-only toggle — re-queries
// immediately. Editing the From / To pickers drops the active preset and waits
// for the next Fetch (so a half-typed datetime never fires a query).
//
// Security note — the resource / method / keyId filters are allow-list
// validated server-side before being interpolated into a log-query expression
// (defense against query-language injection). The constants in this file mirror
// that allow-list; keeping the two in sync is a soft contract.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import {
  Alert,
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
import { FormattedMessage, useIntl } from 'react-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoadingBlock, SubmitButton } from '@vectros-ai/react';

import { useActiveTenantId } from '../../auth';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { VectrosError } from '../../api/vectrosApi';
import type { AdminLogsResponse, LogEntry } from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type { AdminLogsQuery, AppContextSummary } from '../../api/developerApi';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';

// ---------------------------------------------------------------------------
// Constants — mirror the server's accepted resource / method allow-lists.
// Keep these in sync if the backend's accepted values evolve; there is no
// automated check for frontend drift today.
// ---------------------------------------------------------------------------

/** Resources the backend will accept. Out-of-list values are rejected with 400. */
const RESOURCES = [
  'documents',
  'records',
  'search',
  'schemas',
  'folders',
  'clients',
  'orgs',
  'users',
  'usage',
  'auth',
  'models',
  'ping',
  'rag',
  'chat',
  'ask',
] as const;
type Resource = (typeof RESOURCES)[number];

/** HTTP methods supported by the backend filter. */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

/** Quick-pick time windows shown as chips above the datetime pickers. */
const PRESETS = [
  { id: 'logs.presetLast30m', minutes: 30 },
  { id: 'logs.presetLast1h', minutes: 60 },
  { id: 'logs.presetLast6h', minutes: 360 },
  { id: 'logs.presetLast24h', minutes: 1440 },
] as const;

/** Mirror of the server's accepted key-id format (`^[A-Za-z0-9_-]{1,64}$`). */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Default result-set size; the server clamps to a hard cap of 500. */
const DEFAULT_LIMIT = 200;

/** Sentinel for the context selector's "All contexts" option — the default,
 *  tenant-wide view. An empty context sends no context filter to the server. */
const ALL_CONTEXTS = '';

// ---------------------------------------------------------------------------
// Time helpers — the `<input type="datetime-local">` value is a LOCAL-time
// string in `YYYY-MM-DDTHH:MM` shape (no zone marker, no seconds). The API
// expects ISO-8601 UTC. We convert at the boundary so filter state mirrors
// the shape that flows directly into the input control.
// ---------------------------------------------------------------------------

/** Format a Date as a `YYYY-MM-DDTHH:MM` local-time value (datetime-local input). */
function toLocalDateTimeInputValue(date: Date): string {
  // Manual pad — `Date#toISOString` produces UTC; we need local.
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/** Build a `{ startTime, endTime }` window ending now, going back `minutes`. */
function windowOfLastMinutes(minutes: number): {
  startTime: string;
  endTime: string;
} {
  const end = new Date();
  const start = new Date(end.getTime() - minutes * 60 * 1000);
  return {
    startTime: toLocalDateTimeInputValue(start),
    endTime: toLocalDateTimeInputValue(end),
  };
}

/** Convert a datetime-local string (local time) to an ISO-8601 UTC string. */
function localDateTimeToIsoUtc(localDateTimeStr: string): string {
  // `new Date(s)` interprets the no-zone form as local time on every modern
  // browser engine. `.toISOString()` then emits UTC. Same conversion the
  // dev-portal source uses.
  return new Date(localDateTimeStr).toISOString();
}

// ---------------------------------------------------------------------------
// Filter shape
// ---------------------------------------------------------------------------

/**
 * The filter form's state. Stored twice on the page:
 *   - `pendingFilters` — what the user is currently editing (every keystroke).
 *   - `appliedFilters` — what's reflected in the active query. `null` until
 *     the user has clicked Fetch at least once (the "idle" state).
 *
 * Splitting the two keeps the query stable across edits and makes the
 * "you've changed filters but haven't refetched" relationship visible.
 */
interface LogFilters {
  /** Start of window, datetime-local string. */
  readonly startTime: string;
  /** End of window, datetime-local string. */
  readonly endTime: string;
  /** Resource filter or '' for "all resources". */
  readonly resource: Resource | '';
  /** HTTP method filter or '' for "all methods". */
  readonly method: Method | '';
  /** Specific API key id to filter by, or '' for "all keys". */
  readonly keyId: string;
  /** When true, only entries with status >= 400 are returned. */
  readonly errorsOnly: boolean;
}

/** Initial pending filters — last 1 hour, no other filters set. */
function defaultPendingFilters(): LogFilters {
  return {
    ...windowOfLastMinutes(60),
    resource: '',
    method: '',
    keyId: '',
    errorsOnly: false,
  };
}

/**
 * Build the query from current filters. Skips empty fields so the request shape
 * matches `?param` semantics (omitting a query param is different from sending
 * `?param=`). The account (tenant + all its contexts) is derived server-side
 * from the account owner's session, not from the body.
 */
function buildApiRequest(filters: LogFilters): AdminLogsQuery {
  return {
    startTime: localDateTimeToIsoUtc(filters.startTime),
    endTime: localDateTimeToIsoUtc(filters.endTime),
    limit: DEFAULT_LIMIT,
    ...(filters.resource ? { resource: filters.resource } : {}),
    ...(filters.method ? { method: filters.method } : {}),
    ...(filters.keyId ? { keyId: filters.keyId } : {}),
    ...(filters.errorsOnly ? { errorsOnly: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Chip subcomponents — pure render helpers, no own state. Colors use MUI
// palette tokens (theme.palette.*) so partner forks inherit theme overrides
// rather than hardcoded hex.
// ---------------------------------------------------------------------------

/** Compact HTTP-status chip — green / yellow / red by severity class. */
function StatusChip({ status }: { status: number }): React.JSX.Element | null {
  if (!status) return null;
  const color: 'success' | 'warning' | 'error' =
    status >= 500 ? 'error' : status >= 400 ? 'warning' : 'success';
  return <Chip label={status} size="small" color={color} sx={{ fontWeight: 600 }} />;
}

/** Method chip — verb-coded color via the MUI palette. */
function MethodChip({ method }: { method: string }): React.JSX.Element {
  const palette: Record<string, 'info' | 'success' | 'warning' | 'error'> = {
    GET: 'info',
    POST: 'success',
    PUT: 'warning',
    DELETE: 'error',
  };
  const color = palette[method.toUpperCase()];
  if (!color) {
    return (
      <Chip
        label={method || <FormattedMessage id="logs.cellEmpty" />}
        size="small"
        variant="outlined"
      />
    );
  }
  return <Chip label={method} size="small" color={color} variant="outlined" />;
}

/**
 * Resource chip — a neutral, outlined pill. Method already carries the
 * verb-coded color; the resource reads as a quiet, on-brand tag (border +
 * muted text) rather than a saturated fill, matching the flat/bordered theme.
 */
function ResourceChip({
  resource,
}: {
  resource: string | null | undefined;
}): React.JSX.Element {
  if (!resource || resource === 'null') {
    return (
      <Typography component="span" color="text.disabled">
        <FormattedMessage id="logs.cellEmpty" />
      </Typography>
    );
  }
  return (
    <Chip
      label={resource}
      size="small"
      variant="outlined"
      sx={{
        fontWeight: 500,
        color: 'text.secondary',
        borderColor: 'divider',
        bgcolor: 'action.hover',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// LogsPage
// ---------------------------------------------------------------------------

export function LogsPage(): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const queryClient = useQueryClient();

  // Pending = the form's current state; Applied = what the active query is
  // keyed on. Apply / Fetch copies pending → applied, which changes the
  // queryKey and triggers a refetch.
  const [pendingFilters, setPendingFilters] = useState<LogFilters>(
    defaultPendingFilters,
  );
  const [appliedFilters, setAppliedFilters] = useState<LogFilters | null>(null);
  // The active time-horizon preset in minutes, or null for a custom range (set
  // when the user edits From / To by hand). Drives the selected ToggleButton +
  // the "Showing last 1h / custom range" indicator. Starts matching the default
  // 1h window.
  const [preset, setPreset] = useState<number | null>(60);

  // Which app context's activity to show. The account activity log is tenant-wide
  // by default (every context); the selector is an OPTIONAL filter that narrows to
  // one context. Starts on "All contexts".
  const [selectedContext, setSelectedContext] = useState<string>(ALL_CONTEXTS);

  // Load the account's app contexts to populate the filter. Owner-gated developer
  // API — the same source (and cache key) the App Contexts page uses, and the only
  // surface that can enumerate every context. Best-effort: if it fails, the filter
  // stays on "All contexts" and logs still work.
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

  // Derived validation — purely from `pendingFilters`. The Apply button
  // disables when any is true; inline error messages render adjacent to
  // the offending input.
  const keyIdInvalid = useMemo<boolean>(
    () => pendingFilters.keyId !== '' && !KEY_ID_PATTERN.test(pendingFilters.keyId),
    [pendingFilters.keyId],
  );
  const timeRangeInvalid = useMemo<boolean>(() => {
    // Empty strings happen briefly while a picker is being edited; treat
    // those as "not yet invalid" rather than flashing the error.
    if (!pendingFilters.startTime || !pendingFilters.endTime) return false;
    return (
      new Date(pendingFilters.startTime).getTime() >=
      new Date(pendingFilters.endTime).getTime()
    );
  }, [pendingFilters.startTime, pendingFilters.endTime]);
  const applyDisabled = keyIdInvalid || timeRangeInvalid;

  // Keyed on the selected context too: changing the context filter re-queries on
  // its own once a fetch has run.
  const queryKey = ['adminLogs', tenant, selectedContext, appliedFilters] as const;
  const logsQuery = useQuery<AdminLogsResponse>({
    queryKey,
    queryFn: () => {
      if (appliedFilters === null) {
        // Guarded by `enabled` below; this branch is unreachable but
        // satisfies the type checker.
        return Promise.reject(new Error('No applied filters'));
      }
      // Account-wide read via the owner-gated developer API: no context filter
      // returns activity across every context; a selected context narrows to it.
      return devApi.getAdminLogs({
        ...buildApiRequest(appliedFilters),
        ...(selectedContext ? { contextId: selectedContext } : {}),
      });
    },
    enabled: appliedFilters !== null,
  });
  const data = logsQuery.data ?? null;
  const entries: LogEntry[] = data?.entries ?? [];
  // The friendly load-error copy embeds the SDK's own message; ApiErrorAlert
  // appends the requestId (from `logsQuery.error.body`) below it.
  const loadErrorMessage = logsQuery.isError
    ? intl.formatMessage(
        { id: 'logs.loadError' },
        {
          message:
            logsQuery.error instanceof VectrosError
              ? logsQuery.error.message
              : String(logsQuery.error),
        },
      )
    : null;

  // ---- handlers ---------------------------------------------------------

  /**
   * Apply `next` to the form, and — once an initial fetch has happened —
   * re-query immediately so a discrete filter pick takes effect without a
   * second Fetch press (mirrors the developer portal). Never auto-applies an
   * invalid state, and never fires before the user's first explicit Fetch (so
   * we don't run a metered query unprompted).
   */
  const commitFilters = (next: LogFilters): void => {
    setPendingFilters(next);
    if (appliedFilters !== null && !applyDisabled) setAppliedFilters(next);
  };

  /** Discrete time-horizon pick: select the preset, set the window, re-query. */
  const applyPreset = (minutes: number): void => {
    setPreset(minutes);
    commitFilters({ ...pendingFilters, ...windowOfLastMinutes(minutes) });
  };

  /** Manual From / To edit: drop the active preset, update pending only (wait
   *  for the next Fetch — a half-typed datetime shouldn't fire a query). */
  const setTimeField = (field: 'startTime' | 'endTime', value: string): void => {
    setPreset(null);
    setPendingFilters((prev) => ({ ...prev, [field]: value }));
  };

  const handleApply = (): void => {
    if (applyDisabled) return;
    setAppliedFilters(pendingFilters);
  };

  const handleRefresh = (): void => {
    if (appliedFilters === null) return;
    void queryClient.invalidateQueries({ queryKey });
  };

  // "Showing last 1h" / "Showing custom range" indicator copy.
  const horizonLabel: React.ReactNode =
    preset !== null ? (
      <FormattedMessage
        id="logs.showingLast"
        values={{
          label: intl.formatMessage({
            id: PRESETS.find((p) => p.minutes === preset)?.id ?? 'logs.presetLast1h',
          }),
        }}
      />
    ) : (
      <FormattedMessage id="logs.showingCustom" />
    );

  // ---- render -----------------------------------------------------------

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
          <FormattedMessage id="logs.title" />
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
          <FormattedMessage id="logs.subtitle" />
        </Typography>
      </Box>

      {/* Filter form. Two visual groups (time range, filters) inside a single
          Paper. The Paper itself is a labelled section for screen-reader
          navigation; the inner groups have visible overline headings. */}
      <Paper
        component="section"
        aria-labelledby="logs-filter-heading"
        sx={{ p: 2.5 }}
      >
        <Typography
          id="logs-filter-heading"
          variant="h6"
          component="h2"
          // Visually hidden but exposed to assistive tech. Equivalent to
          // the standard "sr-only" pattern.
          sx={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
          }}
        >
          <FormattedMessage id="logs.filtersLegend" />
        </Typography>

        <Stack spacing={2}>
          {/* Scope row — an optional context filter (default: all contexts), over
              what time window. The controls are self-labelled, so no section
              legends are needed; one aligned row keeps the form calm. */}
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 190 }}>
              <InputLabel id="logs-context-label">
                <FormattedMessage id="logs.contextLabel" />
              </InputLabel>
              <Select
                labelId="logs-context-label"
                label={intl.formatMessage({ id: 'logs.contextLabel' })}
                value={
                  selectedContext === ALL_CONTEXTS ||
                  contexts.some((c) => c.contextId === selectedContext)
                    ? selectedContext
                    : ALL_CONTEXTS
                }
                onChange={(e) => setSelectedContext(e.target.value)}
                disabled={contextsQuery.isLoading}
              >
                <MenuItem value={ALL_CONTEXTS}>
                  <em>
                    <FormattedMessage id="logs.contextAll" />
                  </em>
                </MenuItem>
                {contexts.map((c) => (
                  <MenuItem key={c.contextId ?? ''} value={c.contextId ?? ''}>
                    {c.contextId}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Exclusive preset group — the selected value is highlighted so the
                active horizon is always legible. */}
            <ToggleButtonGroup
              exclusive
              size="small"
              value={preset}
              onChange={(_, value: number | null) => {
                // value is null when the already-selected button is re-clicked;
                // ignore that (keep the current horizon) rather than clearing it.
                if (value != null) applyPreset(value);
              }}
              aria-label={intl.formatMessage({ id: 'logs.rangeLegend' })}
            >
              {PRESETS.map((p) => (
                <ToggleButton key={p.id} value={p.minutes} sx={{ minWidth: 0, px: 1.5 }}>
                  <FormattedMessage id={p.id} />
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            <TextField
              size="small"
              type="datetime-local"
              label={intl.formatMessage({ id: 'logs.startTimeLabel' })}
              value={pendingFilters.startTime}
              onChange={(e) => setTimeField('startTime', e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 200 }}
              error={timeRangeInvalid}
            />
            <TextField
              size="small"
              type="datetime-local"
              label={intl.formatMessage({ id: 'logs.endTimeLabel' })}
              value={pendingFilters.endTime}
              onChange={(e) => setTimeField('endTime', e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 200 }}
              error={timeRangeInvalid}
            />

            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {horizonLabel}
            </Typography>
          </Stack>

          {/* Per-context scope hint + the time-range validation message, on
              their own line so they never disturb the row's alignment. */}
          <Stack spacing={0.5} sx={{ mt: -1 }}>
            <Typography variant="caption" color="text.secondary">
              <FormattedMessage id="logs.contextHelp" />
            </Typography>
            {timeRangeInvalid && (
              <Typography variant="caption" color="error">
                <FormattedMessage id="logs.timeRangeInvalid" />
              </Typography>
            )}
          </Stack>

          <Divider />

          {/* Filters + actions — narrowing filters on the left, the query
              actions pushed to the right by a flexible spacer. */}
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="logs-resource-label">
                <FormattedMessage id="logs.resourceLabel" />
              </InputLabel>
              <Select
                labelId="logs-resource-label"
                label={intl.formatMessage({ id: 'logs.resourceLabel' })}
                value={pendingFilters.resource}
                onChange={(e) =>
                  commitFilters({
                    ...pendingFilters,
                    resource: e.target.value as Resource | '',
                  })
                }
              >
                <MenuItem value="">
                  <em>
                    <FormattedMessage id="logs.resourceAll" />
                  </em>
                </MenuItem>
                {RESOURCES.map((r) => (
                  <MenuItem key={r} value={r}>
                    {r}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel id="logs-method-label">
                <FormattedMessage id="logs.methodLabel" />
              </InputLabel>
              <Select
                labelId="logs-method-label"
                label={intl.formatMessage({ id: 'logs.methodLabel' })}
                value={pendingFilters.method}
                onChange={(e) =>
                  commitFilters({
                    ...pendingFilters,
                    method: e.target.value as Method | '',
                  })
                }
              >
                <MenuItem value="">
                  <em>
                    <FormattedMessage id="logs.methodAll" />
                  </em>
                </MenuItem>
                {METHODS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              size="small"
              label={intl.formatMessage({ id: 'logs.keyIdLabel' })}
              value={pendingFilters.keyId}
              onChange={(e) =>
                setPendingFilters((prev) => ({ ...prev, keyId: e.target.value }))
              }
              error={keyIdInvalid}
              // Helper only on error — an always-on hint added height that broke
              // the row's vertical alignment.
              helperText={
                keyIdInvalid ? <FormattedMessage id="logs.keyIdInvalid" /> : undefined
              }
              sx={{ minWidth: 200 }}
              inputProps={{ maxLength: 64, spellCheck: false }}
            />

            {/* No Tooltip wrapper here on purpose — MUI's Tooltip sets
                aria-label on its child, which OVERRIDES the visible text's
                contribution to the accessible name. The visible "Errors only"
                label is self-explanatory. */}
            <ToggleButton
              size="small"
              value="errors"
              selected={pendingFilters.errorsOnly}
              onChange={() =>
                commitFilters({
                  ...pendingFilters,
                  errorsOnly: !pendingFilters.errorsOnly,
                })
              }
              aria-pressed={pendingFilters.errorsOnly}
              sx={{ height: 40 }}
            >
              <FormattedMessage id="logs.errorsOnlyLabel" />
            </ToggleButton>

            {/* Push the query actions to the right edge of the row. */}
            <Box sx={{ flexGrow: 1 }} />

            {/* SubmitButton owns the in-flight spinner + disabled + aria-busy
                wiring. `applyDisabled` composes with the pending disable. */}
            <SubmitButton
              variant="contained"
              onClick={handleApply}
              disabled={applyDisabled}
              pending={logsQuery.isFetching}
              startIcon={<SearchIcon />}
              sx={{ height: 40 }}
            >
              {logsQuery.isFetching ? (
                <FormattedMessage id="logs.fetchInFlight" />
              ) : (
                <FormattedMessage id="logs.fetchCta" />
              )}
            </SubmitButton>

            <Tooltip title={intl.formatMessage({ id: 'logs.refresh' })}>
              <span>
                <Button
                  variant="outlined"
                  onClick={handleRefresh}
                  disabled={appliedFilters === null || logsQuery.isFetching}
                  startIcon={<RefreshIcon />}
                  aria-label={intl.formatMessage({ id: 'logs.refresh' })}
                  sx={{ height: 40 }}
                >
                  <FormattedMessage id="logs.refresh" />
                </Button>
              </span>
            </Tooltip>
          </Stack>

          {/* Result summary — its own line so it never jostles the controls. */}
          {data && !logsQuery.isFetching && (
            <Typography variant="caption" color="text.secondary">
              <FormattedMessage
                id="logs.resultCount"
                values={{ count: entries.length }}
              />
              {' · '}
              <FormattedMessage
                id="logs.queryDuration"
                values={{ ms: data.queryDurationMs }}
              />
            </Typography>
          )}
        </Stack>
      </Paper>

      {/* Error state — friendly copy + the requestId for support. */}
      {loadErrorMessage && (
        <ApiErrorAlert error={logsQuery.error}>{loadErrorMessage}</ApiErrorAlert>
      )}

      {/* Idle state — first render, before the user has clicked Fetch. */}
      {appliedFilters === null && !loadErrorMessage && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage id="logs.idle" />
          </Typography>
        </Paper>
      )}

      {/* Loading state — first fetch in flight, no data yet. */}
      {appliedFilters !== null &&
        data === null &&
        !loadErrorMessage &&
        logsQuery.isFetching && (
          <LoadingBlock label={intl.formatMessage({ id: 'logs.loading' })} />
        )}

      {/* Empty state — fetched successfully but no entries match. */}
      {data !== null && entries.length === 0 && !loadErrorMessage && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 1 }}>
            <FormattedMessage id="logs.empty" />
          </Typography>
          <Typography variant="body2" color="text.disabled">
            <FormattedMessage id="logs.emptyHint" />
          </Typography>
        </Paper>
      )}

      {/* Results table — only when there's data to show. */}
      {entries.length > 0 && (
        <Box>
          {data?.truncated && (
            <Alert severity="warning" sx={{ mb: 2 }} role="status">
              <FormattedMessage
                id="logs.truncated"
                values={{ limit: DEFAULT_LIMIT }}
              />
            </Alert>
          )}
          <TableContainer component={Paper}>
            <Table
              size="small"
              aria-label={intl.formatMessage({ id: 'logs.tableLabel' })}
              sx={{ tableLayout: 'fixed' }}
            >
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 180, fontWeight: 600 }}>
                    <FormattedMessage id="logs.columnTime" />
                  </TableCell>
                  <TableCell sx={{ width: 90, fontWeight: 600 }}>
                    <FormattedMessage id="logs.columnMethod" />
                  </TableCell>
                  <TableCell sx={{ width: 120, fontWeight: 600 }}>
                    <FormattedMessage id="logs.columnResource" />
                  </TableCell>
                  <TableCell sx={{ width: 130, fontWeight: 600 }}>
                    <FormattedMessage id="logs.columnContext" />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <FormattedMessage id="logs.columnPath" />
                  </TableCell>
                  <TableCell sx={{ width: 80, fontWeight: 600 }}>
                    <FormattedMessage id="logs.columnStatus" />
                  </TableCell>
                  <TableCell sx={{ width: 90, fontWeight: 600 }}>
                    <FormattedMessage id="logs.columnLatency" />
                  </TableCell>
                  <TableCell sx={{ width: 160, fontWeight: 600 }}>
                    <FormattedMessage id="logs.columnKeyId" />
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {entries.map((entry, i) => (
                  <LogRow
                    // The endpoint has no per-entry id; (timestamp, status, path)
                    // is effectively unique at our resolution, but index suffix
                    // is the safest stable key for React reconciliation.
                    key={`${entry.timestamp}-${i}`}
                    entry={entry}
                  />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// LogRow — one table row, extracted so we can keep the main return shallow
// and so per-row logic (status-class background, monospace columns, truncation
// tooltips) is co-located.
// ---------------------------------------------------------------------------

function LogRow({ entry }: { entry: LogEntry }): React.JSX.Element {
  const intl = useIntl();
  // Row background by status class — error.lighter / warning.lighter / inherit.
  // The theme's `lighter` variants are MUI v7's per-color subtle backgrounds;
  // they don't conflict with the table's striped-row patterns when a theme adds
  // them later.
  const bgcolor: string =
    entry.status >= 500
      ? 'error.lighter'
      : entry.status >= 400
        ? 'warning.lighter'
        : 'inherit';
  const emDash = intl.formatMessage({ id: 'logs.cellEmpty' });

  return (
    <TableRow sx={{ bgcolor, '&:hover': { bgcolor: 'action.hover' } }}>
      <TableCell
        sx={{
          fontFamily: 'monospace',
          fontSize: 12,
          color: 'text.secondary',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.timestamp
          ? new Date(entry.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              fractionalSecondDigits: 3,
            })
          : emDash}
      </TableCell>
      <TableCell>
        <MethodChip method={entry.method} />
      </TableCell>
      <TableCell>
        <ResourceChip resource={entry.resource} />
      </TableCell>
      <TableCell
        sx={{
          fontFamily: 'monospace',
          fontSize: 12,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'text.secondary',
        }}
      >
        <Tooltip title={entry.contextId ?? ''}>
          <span>{entry.contextId && entry.contextId !== 'null' ? entry.contextId : emDash}</span>
        </Tooltip>
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
        <Tooltip title={entry.path ?? ''}>
          <span>{entry.path ?? emDash}</span>
        </Tooltip>
      </TableCell>
      <TableCell>
        <StatusChip status={entry.status} />
      </TableCell>
      <TableCell
        sx={{
          fontFamily: 'monospace',
          fontSize: 12,
          color: latencyColor(entry.durationMs),
        }}
      >
        {entry.durationMs != null ? `${entry.durationMs}ms` : emDash}
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
        <Tooltip title={entry.keyId ?? ''}>
          <span>{entry.keyId ?? emDash}</span>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

/** Latency color thresholds — visually flag slow calls without a hard cutoff. */
function latencyColor(durationMs: number | null | undefined): string {
  if (durationMs == null) return 'text.disabled';
  if (durationMs > 5000) return 'error.main';
  if (durationMs > 2000) return 'warning.main';
  return 'text.secondary';
}
