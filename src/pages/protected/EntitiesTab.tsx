// ---------------------------------------------------------------------------
// EntitiesTab — ContextDetailPage's "Entities" tab: a READ-ONLY, per-context,
// override-aware browser over the generic identity-entity surface
// (`GET /v1/entities/{namespace}`).
//
// Namespaces this context can see are the tenant-wide ∪ context-own merge
// from `lib/namespaceRegistry.ts`, filtered to `entityBacked` — a namespace
// that isn't entity-backed has no entities to browse by definition. `org`
// and `client` are NOT built-ins: a freshly created tenant registers
// nothing, so the common case is zero entity-backed namespaces — the empty
// state below explains that plainly rather than reading as broken.
//
// This tab can browse, never register or edit. Namespace writes (create/
// update/delete) need root or a provisioning capability; entity writes are
// gated on the ordinary `entities:<verb>:<namespace>` scope instead — a
// grantable action, not a root-only one. Neither has a console-reachable
// path here regardless: this lane is read-only by scope (no create/edit UI
// at all), not because the entity-write gate itself is unusually strict.
//
// Entity payloads are schema-governed (`schemaId`/`schemaVersion`); the
// detail view resolves the entity's schema and renders it read-only via
// `@vectros-ai/react`'s schema-ui primitives (`schemasForSurface(..., 'entity')`
// + `RecordFormFields` with `disabled`) rather than hand-rolling a payload
// renderer a second time. A payload key the resolved schema doesn't declare
// (a stale/deleted schema, or a schema this session can't read — see the
// `schemas:r` note below) still renders, as a raw JSON fallback — never
// silently dropped.
//
// **Authorization is per-namespace, not per-tab.** `entities:r[:<namespace>]`
// gates entity reads, and this app's session may hold it for some namespaces
// and not others (a scoped credential, not just the owner wildcard). A 403
// on one namespace's entities is shown inline on that namespace, not as a
// page-wide error — the other namespaces stay browsable. `GET /v1/schemas`
// additionally needs `schemas:r`; if that call fails for any reason
// (including a 403), the detail view falls back to the raw-payload rendering
// for every entity rather than blocking the whole tab on a scope this
// session may simply not hold.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { FormattedMessage, useIntl } from 'react-intl';
import { useQuery } from '@tanstack/react-query';
import { ApiErrorAlert, LoadingBlock, RecordFormFields, schemasForSurface } from '@vectros-ai/react';
import type { TypedSchema } from '@vectros-ai/react';

import { useActiveTenantId } from '../../auth';
import { vectrosApiClient } from '../../api/vectrosApi';
import type { EntityResponse } from '../../api/vectrosApi';
import { accessQueryKeys } from '../../lib/accessQueryKeys';
import { drainPages, AUTH_PAGE_SIZE } from '../../lib/drainPages';
import { useNamespaceRegistry } from '../../lib/namespaceRegistry';
import type { RegisteredNamespace } from '../../lib/namespaceRegistry';

// ---------------------------------------------------------------------------
// EntitiesTab
// ---------------------------------------------------------------------------

export function EntitiesTab({ ctxId }: { ctxId: string }): React.JSX.Element {
  const intl = useIntl();
  const { namespaces, isLoading, isError, error } = useNamespaceRegistry(ctxId);
  const entityNamespaces = useMemo(
    () => namespaces.filter((ns) => ns.entityBacked),
    [namespaces],
  );
  const [selected, setSelected] = useState<string | null>(null);

  // Keep the selection valid as the namespace list resolves/changes — default
  // to the first entity-backed namespace, and fall back to null once none remain.
  useEffect(() => {
    if (entityNamespaces.length === 0) {
      setSelected(null);
      return;
    }
    if (!entityNamespaces.some((ns) => ns.namespace === selected)) {
      setSelected(entityNamespaces[0]!.namespace);
    }
  }, [entityNamespaces, selected]);

  const selectedNamespace = entityNamespaces.find((ns) => ns.namespace === selected) ?? null;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage id="access.entities.subtitle" />
      </Typography>

      {isError && (
        <ApiErrorAlert error={error}>
          <FormattedMessage id="access.entities.loadError" />
        </ApiErrorAlert>
      )}

      {isLoading && !isError && (
        <LoadingBlock label={intl.formatMessage({ id: 'access.entities.loading' })} />
      )}

      {!isLoading && !isError && entityNamespaces.length === 0 && <NoEntityNamespaces />}

      {!isLoading && !isError && entityNamespaces.length > 0 && (
        <>
          <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
            <Tabs
              value={selected ?? false}
              onChange={(_evt, value: string) => setSelected(value)}
              variant="scrollable"
              scrollButtons="auto"
              aria-label={intl.formatMessage({ id: 'access.entities.namespaceTabsLabel' })}
            >
              {/* Raw `ns.namespace` is safe as a DOM id/aria-controls value
                  with no sanitizing: every namespace here came back from the
                  registry, so it already passed the backend's own namespace
                  grammar (lowercase-letter-first, then `[a-z0-9_-]` only —
                  no spaces, no other punctuation, ever). */}
              {entityNamespaces.map((ns) => (
                <Tab
                  key={ns.namespace}
                  value={ns.namespace}
                  label={ns.namespace}
                  id={`entities-tab-${ns.namespace}`}
                  aria-controls={`entities-tabpanel-${ns.namespace}`}
                  sx={{ fontFamily: 'monospace' }}
                />
              ))}
            </Tabs>
          </Box>
          {/* `key` forces a full remount whenever the SELECTED namespace's
              identity changes: NamespaceEntities' pagination state (cursor,
              accumulated pages) must never carry over — a stale cursor
              paired with a new query would be rejected by the API ("a
              cursor is valid only for the exact query that returned it"). A
              `useEffect` reset can't prevent this: it runs AFTER the render
              that already constructed the mismatched query. `namespace.name`
              alone already disambiguates which TAB is selected (tabs are
              keyed by name just above, so no two are ever the same name);
              `contextId` is in the key too because a background registry
              refetch can flip the SAME name's resolved ownership (tenant-wide
              ↔ this context's own, via `mergeNamespaces`' shadowing) without
              the user switching tabs at all — that resolution change needs
              the same clean remount as an actual tab switch does. */}
          {selectedNamespace && (
            <div
              role="tabpanel"
              id={`entities-tabpanel-${selectedNamespace.namespace}`}
              aria-labelledby={`entities-tab-${selectedNamespace.namespace}`}
            >
              <NamespaceEntities
                key={`${selectedNamespace.namespace}|${selectedNamespace.contextId ?? ''}`}
                ctxId={ctxId}
                namespace={selectedNamespace}
              />
            </div>
          )}
        </>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// NoEntityNamespaces — the common case for a fresh account: nothing registered yet.
// Explains what a namespace is and how one gets registered — this console
// can browse, not register, so the copy never implies a button exists here.
// ---------------------------------------------------------------------------

function NoEntityNamespaces(): React.JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 3, borderStyle: 'dashed' }}>
      <Stack spacing={1.5}>
        <Typography variant="body1" sx={{ fontWeight: 600 }}>
          <FormattedMessage id="access.entities.empty.title" />
        </Typography>
        <Typography variant="body2" color="text.secondary">
          <FormattedMessage id="access.entities.empty.whatIsANamespace" />
        </Typography>
        <Typography variant="body2" color="text.secondary">
          <FormattedMessage id="access.entities.empty.howToRegister" />
        </Typography>
      </Stack>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// NamespaceEntities — the entity list for one namespace, forward-paginated
// (accumulating "Load more" rather than a full drain — an entity namespace
// has no bound on how many rows it can hold, unlike this app's other lists).
// ---------------------------------------------------------------------------

function NamespaceEntities({
  ctxId,
  namespace,
}: {
  ctxId: string;
  namespace: RegisteredNamespace;
}): React.JSX.Element {
  const intl = useIntl();
  const tenant = useActiveTenantId();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Pages accumulated so far, keyed by the cursor that FETCHED each one
  // ('' for the first page). A Map keyed this way makes merging a page
  // idempotent by construction — a background refetch of a cursor already
  // held (TanStack Query's own `refetchOnReconnect`, or a StrictMode
  // double-invoke) re-sets the SAME key rather than appending a duplicate
  // copy — so no separate "have we already merged this" guard is needed.
  const [pagesByCursor, setPagesByCursor] = useState<ReadonlyMap<string, readonly EntityResponse[]>>(
    new Map(),
  );
  const [detailEntity, setDetailEntity] = useState<EntityResponse | null>(null);
  // The last successfully-fetched page's own `nextCursor` — tracked
  // separately from the CURRENT query's `data.nextCursor` because a failed
  // page-2+ fetch leaves `pageQuery.data` undefined, which would otherwise
  // read as "no more pages" and make "Load more" vanish with no way back in.
  const [knownNextCursor, setKnownNextCursor] = useState<string | null>(null);

  const pageQuery = useQuery({
    queryKey: [
      ...accessQueryKeys.entities(tenant, namespace.namespace, namespace.contextId),
      cursor ?? null,
    ],
    queryFn: () =>
      vectrosApiClient(tenant, ctxId).identity.listEntities({
        namespace: namespace.namespace,
        // A tenant-placed namespace's entities reject a contextId; a
        // context-placed one's require it — never a filter to pass "just in
        // case".
        ...(namespace.contextId ? { contextId: namespace.contextId } : {}),
        ...(cursor ? { startFrom: cursor } : {}),
        limit: AUTH_PAGE_SIZE,
      }),
  });

  // Commits a SETTLED page into the accumulator — a separate step from
  // display (below) so a page already committed here survives the query
  // moving on to a later cursor. Runs after render, which is exactly why
  // `entities` (below) does NOT wait on it: it folds the CURRENT query's own
  // result in directly, so there is no render where a just-arrived first
  // page reads as "successful but still empty" before this effect commits it.
  useEffect(() => {
    if (!pageQuery.isSuccess) return;
    const key = cursor ?? '';
    setPagesByCursor((prev) =>
      new Map(prev).set(key, (pageQuery.data.data ?? []) as EntityResponse[]),
    );
    setKnownNextCursor(pageQuery.data.nextCursor ?? null);
    // `pageQuery.data` is a fresh object per fetch — depending on it (not on
    // `cursor` alone) is what fires this exactly once per page actually
    // fetched, not once per render with a stable cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageQuery.data]);

  const entities = useMemo(() => {
    const merged = new Map(pagesByCursor);
    if (pageQuery.isSuccess) {
      merged.set(cursor ?? '', (pageQuery.data.data ?? []) as EntityResponse[]);
    }
    return Array.from(merged.values()).flat();
  }, [pagesByCursor, pageQuery.data, pageQuery.isSuccess, cursor]);
  // Same reasoning as `entities` above: fold in the CURRENT query's own
  // result directly rather than waiting on the commit effect, so "Load
  // more" doesn't flash present-then-briefly-absent for one render after
  // the last page's fetch succeeds.
  const nextCursor = pageQuery.isSuccess ? pageQuery.data.nextCursor ?? null : knownNextCursor;
  const schemasForNamespace = useSchemasForEntitySurface(ctxId);
  // The first page failing (cursor === undefined) means nothing is loaded at
  // all — the namespace-level ApiErrorAlert below is the only affordance,
  // and it's the right one. A page-2+ failure is a DIFFERENT case: rows from
  // earlier pages are already on screen, and the retry box below (not this
  // alert) is the recovery path — showing both here would be two
  // conflicting things to do about the one failure, and this alert's own
  // copy ("Refresh") would read as "discard what you've already loaded."
  const firstPageFailed = pageQuery.isError && cursor === undefined;
  const laterPageFailed = pageQuery.isError && cursor !== undefined;

  return (
    <Stack spacing={1.5} sx={{ mt: 2 }}>
      {firstPageFailed && (
        <ApiErrorAlert error={pageQuery.error}>
          <FormattedMessage
            id="access.entities.namespaceLoadError"
            values={{ namespace: namespace.namespace }}
          />
        </ApiErrorAlert>
      )}

      {pageQuery.isLoading && (
        <LoadingBlock
          label={intl.formatMessage(
            { id: 'access.entities.loadingNamespace' },
            { namespace: namespace.namespace },
          )}
        />
      )}

      {!pageQuery.isLoading && !pageQuery.isError && entities.length === 0 && (
        <Paper sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage
              id="access.entities.namespaceEmpty"
              values={{ namespace: namespace.namespace }}
            />
          </Typography>
        </Paper>
      )}

      {entities.length > 0 && (
        <TableContainer component={Paper}>
          <Table
            size="small"
            aria-label={intl.formatMessage(
              { id: 'access.entities.tableLabel' },
              { namespace: namespace.namespace },
            )}
          >
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.entities.columnName" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.entities.columnExternalId" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.entities.columnStatus" />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="access.entities.columnCreated" />
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entities.map((entity, index) => (
                <TableRow
                  key={entity.id ?? `entity-${index}`}
                  hover
                  onClick={() => setDetailEntity(entity)}
                  tabIndex={0}
                  aria-label={intl.formatMessage(
                    { id: 'access.entities.openRow' },
                    { name: entity.name ?? entity.externalId ?? entity.id ?? '' },
                  )}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setDetailEntity(entity);
                    }
                  }}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>{entity.name ?? '—'}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {entity.externalId ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" label={entity.status ?? '—'} />
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
                    {entity.createdAt ? intl.formatDate(entity.createdAt) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {laterPageFailed && (
        <Box>
          <Typography variant="body2" color="error.main" role="alert" sx={{ mb: 0.5 }}>
            <FormattedMessage id="access.entities.loadMoreFailed" />
          </Typography>
          <Button
            size="small"
            variant="text"
            disabled={pageQuery.isFetching}
            onClick={() => void pageQuery.refetch()}
          >
            <FormattedMessage id="access.entities.loadMoreRetry" />
          </Button>
        </Box>
      )}

      {!laterPageFailed && nextCursor && !pageQuery.isLoading && (
        <Box>
          <Button size="small" variant="text" onClick={() => setCursor(nextCursor)}>
            <FormattedMessage id="access.entities.loadMore" />
          </Button>
        </Box>
      )}

      {detailEntity && (
        <EntityDetailDialog
          entity={detailEntity}
          schemas={schemasForNamespace}
          onClose={() => setDetailEntity(null)}
        />
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Schema resolution — fetched once per tab visit (not per namespace): an
// entity-surface schema is homed in this context OR the tenant-wide home
// (same split as namespaces), and `GET /v1/schemas?surface=entity` already
// returns that merge server-side — the CALLING context comes from the
// bearer `vectrosApiClient(tenant, ctxId)` mints, not a query param (unlike
// `listNamespaces`/`listEntities`, `listSchemas` takes no `contextId`).
// `schemasForSurface` is still applied client-side as the defensive filter
// it exists for.
// ---------------------------------------------------------------------------

function useSchemasForEntitySurface(ctxId: string): {
  readonly byId: ReadonlyMap<string, TypedSchema>;
  readonly isError: boolean;
} {
  const tenant = useActiveTenantId();
  const schemasQuery = useQuery({
    queryKey: accessQueryKeys.entitySurfaceSchemas(tenant, ctxId),
    queryFn: () =>
      drainPages((startFrom) =>
        vectrosApiClient(tenant, ctxId).schemas.listSchemas(
          startFrom === undefined
            ? { surface: 'entity', limit: AUTH_PAGE_SIZE }
            : { surface: 'entity', startFrom, limit: AUTH_PAGE_SIZE },
        ),
      ),
    enabled: ctxId !== '',
    // A 403 here (this session may not hold `schemas:r`) is not retried —
    // the detail view's raw-payload fallback handles it, not a spinner loop.
    retry: false,
  });

  const byId = useMemo(() => {
    const entitySchemas = schemasForSurface(schemasQuery.data ?? [], 'entity');
    const map = new Map<string, TypedSchema>();
    for (const schema of entitySchemas) {
      if (schema.id) map.set(schema.id, schema);
    }
    return map;
  }, [schemasQuery.data]);

  return { byId, isError: schemasQuery.isError };
}

// ---------------------------------------------------------------------------
// EntityDetailDialog — read-only payload view. Resolves the entity's own
// schema by id and renders via RecordFormFields(disabled); falls back to raw
// JSON when the schema can't be resolved (deleted, or unreadable — see the
// module doc comment on `schemas:r`).
//
// The raw payload is ALWAYS rendered, schema or no schema — never only in the
// no-schema branch. A resolved schema only ever renders a subset of the
// payload (RecordFormFields skips array/object fields and any key the schema
// doesn't declare, surfacing each only as a bare key-name chip — the chip
// names the field, it never shows that field's own value); this dialog has
// no separate "raw view" toggle for those chips to point at, so showing the
// raw payload unconditionally is what actually keeps the "never silently
// dropped" promise above, rather than just asserting it.
// ---------------------------------------------------------------------------

function EntityDetailDialog({
  entity,
  schemas,
  onClose,
}: {
  entity: EntityResponse;
  schemas: { readonly byId: ReadonlyMap<string, TypedSchema>; readonly isError: boolean };
  onClose: () => void;
}): React.JSX.Element {
  const intl = useIntl();
  const schema = entity.schemaId ? schemas.byId.get(entity.schemaId) : undefined;
  const payload = (entity.payload ?? {}) as Record<string, unknown>;

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="div" noWrap>
            {entity.name ?? entity.externalId ?? entity.id}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            {entity.id}
          </Typography>
        </Box>
        <IconButton
          onClick={onClose}
          aria-label={intl.formatMessage({ id: 'access.entities.detail.close' })}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={`${intl.formatMessage({ id: 'access.entities.columnStatus' })}: ${entity.status ?? '—'}`} />
            {entity.scopes?.map((s) => (
              <Chip key={s} size="small" variant="outlined" sx={{ fontFamily: 'monospace' }} label={s} />
            ))}
          </Stack>

          {!schema && (
            <Alert severity="info">
              <FormattedMessage
                id={
                  schemas.isError
                    ? 'access.entities.detail.schemaUnavailable'
                    : 'access.entities.detail.schemaNotFound'
                }
              />
            </Alert>
          )}

          {schema && (
            <RecordFormFields
              fields={schema.fields ?? []}
              value={payload}
              errors={{}}
              renderHints={schema.renderHints}
              rawOnlyNoteId="access.entities.detail.rawOnlyNote"
              disabled
              onChange={() => {}}
            />
          )}

          {/* Always present — see the block comment above this component. */}
          <Box>
            {schema && (
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
                <FormattedMessage id="access.entities.detail.rawPayloadLabel" />
              </Typography>
            )}
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                bgcolor: 'action.hover',
                borderRadius: 1,
                fontSize: 12,
                overflow: 'auto',
                maxHeight: 320,
              }}
            >
              {JSON.stringify(payload, null, 2)}
            </Box>
          </Box>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
