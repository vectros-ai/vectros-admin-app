// ---------------------------------------------------------------------------
// ContextDetailPage — admin-app's `/access/contexts/:ctxId` detail view.
//
// Functional scope:
//   - Breadcrumb (`Access > {contextId}`) anchored on the URL ctxId so it
//     renders before the context data finishes loading.
//   - Header: context's name + description from `getAppContext`.
//   - Tab strip — Roles / Profiles — with `?tab=roles|profiles`
//     URL state for deep-linkable tabs. Default tab is Roles.
//   - Roles tab: read-only table with Edit + Create actions that route
//     to the RoleEditor, plus Clone + Delete actions.
//   - Profiles tab: read-only table with Edit + Create actions that route
//     to the ProfileEditor, plus Clone + Delete actions.
//
// Cache reuse — and why tab-switch is instant:
//   ContextsPage's row-count parallel `useQueries` already populate
//   `accessQueryKeys.roles(ctxId)` and `accessQueryKeys.profiles(ctxId)`
//   for every context the partner has. When the user clicks into a context,
//   THIS page's `useQuery` on the same key returns the cached data without
//   a round-trip. The tab strip then switches between two ALREADY-loaded
//   tables. The smart-redirect from ContextsPage (when N=1) also benefits
//   — the partner clicks once and sees the populated tabs immediately.
// ---------------------------------------------------------------------------

import { useMemo } from 'react';
import {
  Link as RouterLink,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  IconButton,
  Link,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import { FormattedMessage, useIntl } from 'react-intl';
import { LoadingBlock } from '@vectros-ai/react';
import { useQuery } from '@tanstack/react-query';

import { useActiveTenantId } from '../../auth';
import { vectrosApiClient } from '../../api/vectrosApi';
import type {
  AccessProfileResponse,
  RoleResponse,
} from '../../api/vectrosApi';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { usePrincipalDirectory } from '../../lib/usePrincipalDirectory';
import type { ResolvedPrincipal } from '../../lib/usePrincipalDirectory';

// ---------------------------------------------------------------------------
// Constants — recognized tab values. Anything else in `?tab=` falls back to
// the default ('roles'). Using a typed tuple keeps the URL → state
// mapping a typecheck error away from drifting.
// ---------------------------------------------------------------------------

const TABS = ['roles', 'profiles'] as const;
type TabValue = (typeof TABS)[number];
const DEFAULT_TAB: TabValue = 'roles';

function parseTab(raw: string | null): TabValue {
  return (TABS as readonly string[]).includes(raw ?? '')
    ? (raw as TabValue)
    : DEFAULT_TAB;
}

// ---------------------------------------------------------------------------
// ContextDetailPage
// ---------------------------------------------------------------------------

export function ContextDetailPage(): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const { ctxId = '' } = useParams<{ ctxId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseTab(searchParams.get('tab'));

  // Context-meta query. Pre-warmed by no current page; first fetch happens
  // here. Tabs render even while this is in flight — the breadcrumb has
  // the ctxId from the URL, which is enough for orientation.
  const contextQuery = useQuery({
    queryKey: accessQueryKeys.appContext(ctxId),
    queryFn: () => vectrosApiClient(tenant, ctxId).auth.getAppContext({ contextId: ctxId }),
    enabled: ctxId !== '',
  });

  const handleTabChange = (_event: React.SyntheticEvent, newValue: TabValue): void => {
    // Preserve other query params (none today, but defensive); REPLACE the
    // history entry — tab switches shouldn't bloat the back-button history.
    const next = new URLSearchParams(searchParams);
    next.set('tab', newValue);
    setSearchParams(next, { replace: true });
  };

  // ---- render ---------------------------------------------------------

  return (
    <Stack spacing={3}>
      {/* Breadcrumb — visible immediately on render (URL-derived). */}
      <Breadcrumbs aria-label={intl.formatMessage({ id: 'access.breadcrumbRoot' })}>
        <Link
          component={RouterLink}
          to="/access/contexts"
          color="inherit"
          underline="hover"
        >
          <FormattedMessage id="access.breadcrumbRoot" />
        </Link>
        <Typography color="text.primary" sx={{ fontFamily: 'monospace', fontSize: 14 }}>
          {ctxId}
        </Typography>
      </Breadcrumbs>

      {/* Header — title + description from the fetched context, with a
          monospaced contextId chip for unambiguous identification. */}
      <Box>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
            {contextQuery.data?.name ?? ctxId}
          </Typography>
          {contextQuery.data?.name && contextQuery.data?.contextId && (
            <Chip
              label={contextQuery.data.contextId}
              size="small"
              sx={{ fontFamily: 'monospace' }}
            />
          )}
        </Stack>
        {contextQuery.data?.description && (
          <Typography variant="body1" color="text.secondary">
            {contextQuery.data.description}
          </Typography>
        )}
      </Box>

      {contextQuery.isError && (
        <ApiErrorAlert error={contextQuery.error}>
          <FormattedMessage id="access.contexts.detail.loadError.friendly" />
        </ApiErrorAlert>
      )}

      {/* Tab strip — TabPanels (visibility-toggled containers) below. */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          aria-label={intl.formatMessage({ id: 'access.contexts.detail.tabsLabel' })}
        >
          <Tab
            value="roles"
            label={<FormattedMessage id="access.roles.title" />}
          />
          <Tab
            value="profiles"
            label={<FormattedMessage id="access.profiles.title" />}
          />
        </Tabs>
      </Box>

      {activeTab === 'roles' && <RolesTab ctxId={ctxId} />}
      {activeTab === 'profiles' && <ProfilesTab ctxId={ctxId} />}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// RolesTab — read-only list. Create + Edit route to the RoleEditor, which
// owns the editor + clone + delete actions.
// ---------------------------------------------------------------------------

function RolesTab({ ctxId }: { ctxId: string }): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const tenant = useActiveTenantId();

  const rolesQuery = useQuery({
    queryKey: accessQueryKeys.roles(ctxId),
    queryFn: () =>
      drainPages<RoleResponse>((startFrom) =>
        vectrosApiClient(tenant, ctxId).auth.listRoles(
          startFrom === undefined
            ? { contextId: ctxId, limit: AUTH_PAGE_SIZE }
            : { contextId: ctxId, startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
    enabled: ctxId !== '',
  });
  const roles: RoleResponse[] = useMemo(
    () => rolesQuery.data ?? [],
    [rolesQuery.data],
  );

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          <FormattedMessage id="access.roles.subtitle" />
        </Typography>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate(`/access/contexts/${ctxId}/roles/new`)}
          >
            <FormattedMessage id="access.roles.createButton" />
          </Button>
        </Stack>
      </Box>

      {rolesQuery.isError && (
        <ApiErrorAlert error={rolesQuery.error}>
          <FormattedMessage id="access.roles.loadError.friendly" />
        </ApiErrorAlert>
      )}

      {rolesQuery.isLoading && !rolesQuery.isError && (
        <LoadingBlock label={intl.formatMessage({ id: 'access.roles.loading' })} />
      )}

      {rolesQuery.isSuccess && roles.length === 0 && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage id="access.roles.empty" />
          </Typography>
        </Paper>
      )}

      {rolesQuery.isSuccess && roles.length > 0 && (
        <TableContainer component={Paper}>
          <Table aria-label={intl.formatMessage({ id: 'access.roles.title' })}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.roles.columnId" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.roles.columnName" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.roles.columnDescription" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }} align="right">
                  <FormattedMessage id="access.roles.columnClauses" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.roles.columnUpdated" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }} align="right">
                  <FormattedMessage id="access.roles.columnActions" />
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {roles.map((t, index) => (
                <RoleRow
                  key={t.roleId ?? `role-${index}`}
                  role={t}
                  ctxId={ctxId}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}

function RoleRow({
  role,
  ctxId,
}: {
  role: RoleResponse;
  ctxId: string;
}): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const tid = role.roleId ?? '';
  const updated = role.lastModified ?? role.createdAt;

  const open = (): void => {
    if (tid) navigate(`/access/contexts/${ctxId}/roles/${tid}`);
  };
  // Keyboard affordance for the clickable row (a <tr> isn't natively operable).
  const onKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>): void => {
    if (!tid) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  return (
    <TableRow
      hover
      onClick={open}
      {...(tid
        ? {
            tabIndex: 0,
            onKeyDown,
            'aria-label': intl.formatMessage(
              { id: 'access.roles.openRow' },
              { roleId: tid },
            ),
          }
        : {})}
      sx={{ cursor: tid ? 'pointer' : 'default' }}
    >
      <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>
        {role.roleId ?? '—'}
      </TableCell>
      <TableCell>{role.name ?? '—'}</TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>
        {role.description ?? '—'}
      </TableCell>
      <TableCell align="right">{role.scopes?.length ?? 0}</TableCell>
      <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
        {updated ? new Date(updated).toLocaleDateString() : '—'}
      </TableCell>
      <TableCell align="right" onClick={(e) => e.stopPropagation()}>
        <Tooltip title={intl.formatMessage({ id: 'access.shared.edit' })}>
          <IconButton
            size="small"
            onClick={open}
            aria-label={intl.formatMessage({ id: 'access.shared.edit' })}
          >
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {/* Clone + Delete live on the RoleEditor page (reached via Edit). */}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// ProfilesTab — read-only list. Create + Edit route to the ProfileEditor,
// which owns the editor + clone + delete actions.
// ---------------------------------------------------------------------------

function ProfilesTab({ ctxId }: { ctxId: string }): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const tenant = useActiveTenantId();
  const [searchParams] = useSearchParams();
  const filterRoleId = searchParams.get('roleId');
  // Resolve `usr_<id>` principals to user emails for the list (loaded once).
  const { resolve: resolvePrincipal } = usePrincipalDirectory();

  const profilesQuery = useQuery({
    queryKey: accessQueryKeys.profiles(ctxId),
    queryFn: () =>
      drainPages<AccessProfileResponse>((startFrom) =>
        vectrosApiClient(tenant, ctxId).auth.listAccessProfiles(
          startFrom === undefined
            ? { contextId: ctxId, limit: AUTH_PAGE_SIZE }
            : { contextId: ctxId, startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
    enabled: ctxId !== '',
  });
  const profiles: AccessProfileResponse[] = useMemo(
    () => profilesQuery.data ?? [],
    [profilesQuery.data],
  );

  // Optional `?roleId=` filter applied client-side. Used by the
  // RoleEditor's "View referencing profiles" link; without
  // a filter param the tab shows all profiles in the context.
  const visibleProfiles = useMemo(() => {
    if (!filterRoleId) return profiles;
    return profiles.filter((p) => p.roleId === filterRoleId);
  }, [profiles, filterRoleId]);

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          <FormattedMessage id="access.profiles.subtitle" />
        </Typography>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate(`/access/contexts/${ctxId}/profiles/new`)}
          >
            <FormattedMessage id="access.profiles.createButton" />
          </Button>
        </Stack>
      </Box>

      {filterRoleId && (
        <Alert
          severity="info"
          role="status"
          action={
            <Button
              size="small"
              color="inherit"
              onClick={() => navigate(`/access/contexts/${ctxId}?tab=profiles`)}
            >
              <FormattedMessage id="access.profiles.clearRoleFilter" />
            </Button>
          }
        >
          <FormattedMessage
            id="access.profiles.filteredByRole"
            values={{ roleId: filterRoleId }}
          />
        </Alert>
      )}

      {profilesQuery.isError && (
        <ApiErrorAlert error={profilesQuery.error}>
          <FormattedMessage id="access.profiles.loadError.friendly" />
        </ApiErrorAlert>
      )}

      {profilesQuery.isLoading && !profilesQuery.isError && (
        <LoadingBlock label={intl.formatMessage({ id: 'access.profiles.loading' })} />
      )}

      {profilesQuery.isSuccess && visibleProfiles.length === 0 && (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            {/* Distinguish "no profiles at all" from "the ?roleId= filter
                matched nothing" so the user isn't misled into thinking the
                context is empty. */}
            {filterRoleId && profiles.length > 0 ? (
              <FormattedMessage
                id="access.profiles.emptyFiltered"
                values={{ roleId: filterRoleId }}
              />
            ) : (
              <FormattedMessage id="access.profiles.empty" />
            )}
          </Typography>
        </Paper>
      )}

      {profilesQuery.isSuccess && visibleProfiles.length > 0 && (
        <TableContainer component={Paper}>
          <Table aria-label={intl.formatMessage({ id: 'access.profiles.title' })}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.profiles.columnPrincipalId" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.profiles.columnSource" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }} align="right">
                  <FormattedMessage id="access.profiles.columnOverrides" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.profiles.columnUpdated" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }} align="right">
                  <FormattedMessage id="access.profiles.columnActions" />
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleProfiles.map((p, index) => (
                <ProfileRow
                  key={p.principalId ?? `profile-${index}`}
                  profile={p}
                  ctxId={ctxId}
                  principal={resolvePrincipal(p.principalId ?? '')}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}

function ProfileRow({
  profile,
  ctxId,
  principal,
}: {
  profile: AccessProfileResponse;
  ctxId: string;
  principal: ResolvedPrincipal;
}): React.JSX.Element {
  const intl = useIntl();
  const navigate = useNavigate();
  const pid = profile.principalId ?? '';
  const isUser = principal.kind === 'user';
  const isKey = principal.kind === 'key';
  const sourceIsRole = !!profile.roleId;
  const updated = profile.lastModified ?? profile.createdAt;
  // identityOverrides shape per the SDK is `Record<string, Record<string, unknown>>`
  // but at runtime it's a flat `Record<string, string>` with only orgId /
  // clientId keys (the backend allow-list). Count the flat keys.
  const overridesCount = profile.identityOverrides
    ? Object.keys(profile.identityOverrides).length
    : 0;

  const open = (): void => {
    if (pid) navigate(`/access/contexts/${ctxId}/profiles/${encodeURIComponent(pid)}`);
  };
  // Keyboard affordance for the clickable row (a <tr> isn't natively operable).
  const onKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>): void => {
    if (!pid) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  return (
    <TableRow
      hover
      onClick={open}
      {...(pid
        ? {
            tabIndex: 0,
            onKeyDown,
            'aria-label': intl.formatMessage(
              { id: 'access.profiles.openRow' },
              { principalId: pid },
            ),
          }
        : {})}
      sx={{ cursor: pid ? 'pointer' : 'default' }}
    >
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          {(isUser || isKey) && (
            <Chip
              size="small"
              label={
                <FormattedMessage
                  id={isUser ? 'access.profiles.principalUser' : 'access.profiles.principalKey'}
                />
              }
              color={isUser ? 'primary' : 'default'}
              variant="outlined"
            />
          )}
          {/* Human-readable label (a user's email) on top; the raw principal id
              beneath it as a quiet monospace reference. For a key (no name
              source) the label IS the id, so we don't repeat it. */}
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
              {principal.label}
            </Typography>
            {/* Show the raw id beneath only when the label is a real name
                (email / externalId) — otherwise the label already IS the id. */}
            {principal.hasName && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: 'monospace' }}
                noWrap
              >
                {pid}
              </Typography>
            )}
          </Box>
        </Stack>
      </TableCell>
      <TableCell>
        {sourceIsRole ? (
          <Chip
            size="small"
            label={
              <FormattedMessage
                id="access.profiles.sourceRole"
                values={{ roleId: profile.roleId }}
              />
            }
            onClick={(e) => {
              e.stopPropagation();
              navigate(
                `/access/contexts/${ctxId}/roles/${profile.roleId}`,
              );
            }}
            sx={{ cursor: 'pointer' }}
          />
        ) : (
          <Chip
            size="small"
            label={
              <FormattedMessage
                id="access.profiles.sourceInline"
                values={{ count: profile.scopes?.length ?? 0 }}
              />
            }
            variant="outlined"
          />
        )}
      </TableCell>
      <TableCell align="right">{overridesCount}</TableCell>
      <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
        {updated ? new Date(updated).toLocaleDateString() : '—'}
      </TableCell>
      <TableCell align="right" onClick={(e) => e.stopPropagation()}>
        <Tooltip title={intl.formatMessage({ id: 'access.shared.edit' })}>
          <IconButton
            size="small"
            onClick={open}
            aria-label={intl.formatMessage({ id: 'access.shared.edit' })}
          >
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {/* Clone + Delete live on the ProfileEditor page (reached via Edit). */}
      </TableCell>
    </TableRow>
  );
}
