// ---------------------------------------------------------------------------
// UsagePage — the account usage & credits report (path: `/usage`).
//
// Renders `GET /v1/usage` (client.auth.getUsage()) for the current billing
// period: account credit totals (used / plan limit / remaining), the
// per-category credit breakdown, read metering (per-call + data-out egress),
// and the live/test environment + per-AppContext decompositions. Read-only —
// the reference surface for "how do I see what my account is consuming?".
//
// Fetches on mount (a usage read is a cheap metadata GET — unlike the metered
// CloudWatch-backed Logs page, no explicit-fetch gate is warranted) and keys
// on the active tenant. The report is account-wide ONLY for a credential with
// cross-context reach (an owner's wildcard); a context-confined credential
// (0.40.0) instead sees every section narrowed to its own context, and the
// environment its context does NOT belong to comes back `null` rather than a
// real total (the `tenants.live` / `tenants.test` split below) — see
// `isContextConfined` for the detectable signal and its two exceptions.
//
// Scope: the backend requires `billing:r` on scoped tokens (API keys always
// pass); the route + nav item gate on the same literal action string.
// ---------------------------------------------------------------------------

import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { FormattedMessage, FormattedNumber, useIntl } from 'react-intl';
import { useQuery } from '@tanstack/react-query';
import { ApiErrorAlert, LoadingBlock } from '@vectros-ai/react';

import { useActiveTenantId } from '../../auth';
import { vectrosApiClient } from '../../api/vectrosApi';
import type { Vectros } from '../../api/vectrosApi';

/** The credit-breakdown categories, in display order. Each maps a
 *  CreditBreakdown field to its i18n label id. */
const BREAKDOWN_ROWS = [
  { field: 'searchQueries', labelId: 'usage.categorySearchQueries' },
  { field: 'searchIngest', labelId: 'usage.categorySearchIngest' },
  { field: 'documents', labelId: 'usage.categoryDocuments' },
  { field: 'records', labelId: 'usage.categoryRecords' },
  { field: 'identity', labelId: 'usage.categoryIdentity' },
  { field: 'storageEstimate', labelId: 'usage.categoryStorage' },
  { field: 'reads', labelId: 'usage.categoryReads' },
  { field: 'dataOut', labelId: 'usage.categoryDataOut' },
] as const;

/** Human-readable byte count (SI, one decimal). Local to this page — the
 *  usage report is its only byte-denominated admin surface. */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = '';
  for (const u of units) {
    value /= 1000;
    unit = u;
    if (value < 1000) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** A number cell — em-dash when the API omitted the value. */
function num(value: number | undefined): React.ReactNode {
  return value === undefined ? '—' : <FormattedNumber value={value} />;
}

/** A limit/allowance cell — `null` from the API means "unlimited". */
function allowance(value: number | null | undefined, unlimitedLabel: string): React.ReactNode {
  if (value === undefined) return '—';
  if (value === null) return unlimitedLabel;
  return <FormattedNumber value={value} />;
}

export function UsagePage(): React.JSX.Element {
  const tenant = useActiveTenantId();
  const intl = useIntl();

  const usageQuery = useQuery({
    // Keyed on tenant so a TenantSwitcher change re-mints the bearer and
    // refetches — the report narrows to whatever that new bearer can see
    // (see the module comment above: account-wide only for cross-context
    // reach, context-narrowed otherwise since 0.40.0).
    queryKey: ['usage', tenant],
    queryFn: () => vectrosApiClient(tenant).auth.getUsage(),
  });

  const report = usageQuery.data;
  const credits = report?.credits;
  const breakdown = credits?.breakdown;
  const reads = report?.reads;
  const unlimited = intl.formatMessage({ id: 'usage.unlimited' });

  // Environment rows (live/test) + per-context rows for the decomposition tables.
  const envRows: ReadonlyArray<{ key: string; detail: Vectros.TenantDetail | null | undefined }> = [
    { key: 'live', detail: report?.tenants?.live },
    { key: 'test', detail: report?.tenants?.test },
  ];
  const contexts = report?.contexts ?? [];

  // 0.40.0: a context-confined credential narrows every section EXCEPT
  // reads.calls.used / reads.dataOut.bytes (no per-context breakdown exists for
  // those, so they always read 0 rather than a narrowed figure — don't read
  // that as "no calls made") and credits.limit (stays plan-wide, so
  // credits.remaining can overstate this context's true remaining room). The
  // detectable client-side signal is the same narrowing the environment split
  // already shows: the environment the credential is NOT bound to comes back
  // `null` rather than a real total.
  // `== null` (not `=== null`) deliberately: the generated SDK type is
  // `(TenantDetail | null) | undefined` — the doc comment promises `null`
  // for the unbound side, but treating an absent key (`undefined`) the same
  // way is strictly safer and costs nothing.
  const isContextConfined =
    report?.tenants != null && (report.tenants.live == null || report.tenants.test == null);

  return (
    <Stack spacing={4}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { sm: 'flex-start' },
          justifyContent: 'space-between',
          gap: 2,
        }}
      >
        <Box>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
            <FormattedMessage id="usage.title" />
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
            <FormattedMessage id="usage.subtitle" />
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          startIcon={<RefreshIcon />}
          onClick={() => void usageQuery.refetch()}
          disabled={usageQuery.isFetching}
          sx={{ flexShrink: 0 }}
        >
          <FormattedMessage id="usage.refresh" />
        </Button>
      </Box>

      {usageQuery.isPending ? (
        <LoadingBlock label={intl.formatMessage({ id: 'usage.loading' })} />
      ) : usageQuery.isError ? (
        <ApiErrorAlert error={usageQuery.error}>
          <FormattedMessage id="usage.error" />
        </ApiErrorAlert>
      ) : (
        <>
          {/* Credits — the headline numbers + per-category decomposition. */}
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 2, flexWrap: 'wrap' }}>
                <Typography variant="h6" component="h2" sx={{ fontWeight: 700 }}>
                  <FormattedMessage id="usage.creditsTitle" />
                </Typography>
                {report?.period && (
                  <Chip size="small" variant="outlined" label={report.period} />
                )}
              </Box>
              <Stack direction="row" spacing={4} sx={{ mb: 2, flexWrap: 'wrap' }} useFlexGap>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    <FormattedMessage id="usage.creditsUsed" />
                  </Typography>
                  <Typography variant="h5">{num(credits?.used)}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    <FormattedMessage id="usage.creditsLimit" />
                  </Typography>
                  <Typography variant="h5">{allowance(credits?.limit, unlimited)}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    <FormattedMessage id="usage.creditsRemaining" />
                  </Typography>
                  <Typography variant="h5">{allowance(credits?.remaining, unlimited)}</Typography>
                </Box>
              </Stack>

              {breakdown && (
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small" aria-label={intl.formatMessage({ id: 'usage.breakdownLabel' })}>
                    <TableHead>
                      <TableRow>
                        <TableCell>
                          <FormattedMessage id="usage.colCategory" />
                        </TableCell>
                        <TableCell align="right">
                          <FormattedMessage id="usage.colCredits" />
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {BREAKDOWN_ROWS.map((row) => (
                        <TableRow key={row.field}>
                          <TableCell>
                            <FormattedMessage id={row.labelId} />
                          </TableCell>
                          <TableCell align="right">{num(breakdown[row.field])}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </CardContent>
          </Card>

          {/* Context-confinement caveat — only the two exceptions the changelog
              calls out precisely; everything else narrows correctly and needs
              no explanation. */}
          {isContextConfined && (
            <Alert severity="info">
              <FormattedMessage id="usage.contextConfinedNotice" />
            </Alert>
          )}

          {/* Read metering — the per-call axis + unified data-out (egress). */}
          {reads && (
            <Card>
              <CardContent>
                <Typography variant="h6" component="h2" sx={{ fontWeight: 700, mb: 0.5 }}>
                  <FormattedMessage id="usage.readsTitle" />
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  <FormattedMessage id="usage.readsSubtitle" />
                </Typography>
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small" aria-label={intl.formatMessage({ id: 'usage.readsLabel' })}>
                    <TableHead>
                      <TableRow>
                        <TableCell>
                          <FormattedMessage id="usage.colAxis" />
                        </TableCell>
                        <TableCell align="right">
                          <FormattedMessage id="usage.colUsed" />
                        </TableCell>
                        <TableCell align="right">
                          <FormattedMessage id="usage.colAllowance" />
                        </TableCell>
                        <TableCell align="right">
                          <FormattedMessage id="usage.colOverage" />
                        </TableCell>
                        <TableCell align="right">
                          <FormattedMessage id="usage.colOverageCredits" />
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      <TableRow>
                        <TableCell>
                          <FormattedMessage id="usage.readsCalls" />
                        </TableCell>
                        <TableCell align="right">{num(reads.calls?.used)}</TableCell>
                        <TableCell align="right">
                          {allowance(reads.calls?.freeAllowance, unlimited)}
                        </TableCell>
                        <TableCell align="right">{num(reads.calls?.overage)}</TableCell>
                        <TableCell align="right">{num(reads.calls?.overageCredits)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>
                          <FormattedMessage id="usage.readsDataOut" />
                        </TableCell>
                        <TableCell align="right">{formatBytes(reads.dataOut?.bytes)}</TableCell>
                        <TableCell align="right">
                          {reads.dataOut?.freeBytes === null
                            ? unlimited
                            : formatBytes(reads.dataOut?.freeBytes)}
                        </TableCell>
                        <TableCell align="right">{formatBytes(reads.dataOut?.overageBytes)}</TableCell>
                        <TableCell align="right">{num(reads.dataOut?.overageCredits)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </TableContainer>
              </CardContent>
            </Card>
          )}

          {/* Environment split — account totals decompose into live + test. */}
          <Card>
            <CardContent>
              <Typography variant="h6" component="h2" sx={{ fontWeight: 700, mb: 2 }}>
                <FormattedMessage id="usage.environmentsTitle" />
              </Typography>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label={intl.formatMessage({ id: 'usage.environmentsLabel' })}>
                  <TableHead>
                    <TableRow>
                      <TableCell>
                        <FormattedMessage id="usage.colEnvironment" />
                      </TableCell>
                      <TableCell align="right">
                        <FormattedMessage id="usage.colCredits" />
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {envRows.map(({ key, detail }) => (
                      <TableRow key={key}>
                        <TableCell>
                          <FormattedMessage id={`usage.environment.${key}`} />
                        </TableCell>
                        <TableCell align="right">{num(detail?.credits?.used)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>

          {/* Per-context decomposition — the finest attribution granularity. */}
          {contexts.length > 0 && (
            <Card>
              <CardContent>
                <Typography variant="h6" component="h2" sx={{ fontWeight: 700, mb: 0.5 }}>
                  <FormattedMessage id="usage.contextsTitle" />
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  <FormattedMessage id="usage.contextsSubtitle" />
                </Typography>
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small" aria-label={intl.formatMessage({ id: 'usage.contextsLabel' })}>
                    <TableHead>
                      <TableRow>
                        <TableCell>
                          <FormattedMessage id="usage.colContext" />
                        </TableCell>
                        <TableCell>
                          <FormattedMessage id="usage.colEnvironment" />
                        </TableCell>
                        <TableCell align="right">
                          <FormattedMessage id="usage.colCredits" />
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {contexts.map((ctx) => (
                        <TableRow key={`${ctx.tenantId ?? ''}-${ctx.contextId ?? ''}`}>
                          <TableCell sx={{ fontFamily: 'monospace' }}>{ctx.contextId ?? '—'}</TableCell>
                          <TableCell>
                            {/* Same localized labels as the environments table
                                above; an unrecognized mode shows raw. */}
                            {ctx.tenantMode === 'live' || ctx.tenantMode === 'test' ? (
                              <FormattedMessage id={`usage.environment.${ctx.tenantMode}`} />
                            ) : (
                              (ctx.tenantMode ?? '—')
                            )}
                          </TableCell>
                          <TableCell align="right">{num(ctx.credits?.used)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </CardContent>
            </Card>
          )}

          {/* The estimate caveat: storage finalizes at cycle end. */}
          <Alert severity="info">
            <FormattedMessage id="usage.estimateNote" />
          </Alert>
        </>
      )}
    </Stack>
  );
}
