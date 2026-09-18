// ---------------------------------------------------------------------------
// EntitiesTab tests.
//
// Pinning:
//   1. Empty state when no namespace is entity-backed (the common case for a
//      fresh account) — explains registration, never implies this console
//      can do it.
//   2. A context-own registration SHADOWS a same-named tenant-wide one in
//      which namespaces actually show up as browsable.
//   3. Populated namespace: entity table renders; clicking a row opens the
//      schema-driven detail view.
//   4. A per-namespace entities 403 is shown inline, not as a page-wide error.
//   5. An unresolvable schema (schemas call fails) falls back to raw JSON,
//      not a blocked page.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { TestTenantProvider } from '../../test/TestTenantProvider';
import { pageOf } from '../../test/pageOf';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { EntitiesTab } from './EntitiesTab';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return { ...actual, vectrosApiClient: vi.fn() };
});

interface MockOverrides {
  listNamespaces?: ReturnType<typeof vi.fn>;
  listEntities?: ReturnType<typeof vi.fn>;
  listSchemas?: ReturnType<typeof vi.fn>;
}

function makeMockClient(o: MockOverrides = {}) {
  return {
    identity: {
      listNamespaces: o.listNamespaces ?? vi.fn().mockResolvedValue(pageOf([])),
      listEntities: o.listEntities ?? vi.fn().mockResolvedValue(pageOf([])),
    },
    schemas: {
      listSchemas: o.listSchemas ?? vi.fn().mockResolvedValue(pageOf([])),
    },
  };
}

function renderTab(client = makeMockClient()) {
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <TestIntlProvider>
        <QueryClientProvider client={queryClient}>
          <TestTenantProvider>
            <EntitiesTab ctxId="engineering" />
          </TestTenantProvider>
        </QueryClientProvider>
      </TestIntlProvider>,
    ),
    client,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('EntitiesTab', () => {
  it('explains registration when no namespace is entity-backed', async () => {
    renderTab(
      makeMockClient({
        listNamespaces: vi.fn().mockResolvedValue(
          pageOf([{ namespace: 'org', entityBacked: false, contextId: undefined }]),
        ),
      }),
    );
    expect(await screen.findByText(/no entity namespaces registered here yet/i)).toBeInTheDocument();
    // Never implies THIS console can register one.
    expect(screen.queryByRole('button', { name: /register/i })).not.toBeInTheDocument();
  });

  it("a context-own registration shadows a same-named tenant-wide one, so it becomes browsable", async () => {
    // Tenant-wide `team` is NOT entity-backed; this context's own `team` IS.
    const listNamespaces = vi.fn().mockImplementation((req?: { contextId?: string }) =>
      Promise.resolve(
        pageOf(
          req?.contextId
            ? [{ namespace: 'team', entityBacked: true, contextId: 'engineering' }]
            : [{ namespace: 'team', entityBacked: false, contextId: undefined }],
        ),
      ),
    );
    renderTab(makeMockClient({ listNamespaces }));
    expect(await screen.findByRole('tab', { name: 'team' })).toBeInTheDocument();
    expect(screen.queryByText(/no entity namespaces registered here yet/i)).not.toBeInTheDocument();
  });

  it('lists entities in the selected namespace and opens the schema-driven detail on click', async () => {
    const user = userEvent.setup();
    const listNamespaces = vi.fn().mockImplementation((req?: { contextId?: string }) =>
      Promise.resolve(
        pageOf(req?.contextId ? [] : [{ namespace: 'team', entityBacked: true, contextId: undefined }]),
      ),
    );
    const listEntities = vi.fn().mockResolvedValue(
      pageOf([
        {
          id: 'ent_1',
          namespace: 'team',
          externalId: 'team_eng',
          name: 'Platform Engineering',
          status: 'ACTIVE',
          payload: { headcount: 12 },
          schemaId: 'schema_team',
          scopes: ['team:ent_1'],
        },
      ]),
    );
    const listSchemas = vi.fn().mockResolvedValue(
      pageOf([
        {
          id: 'schema_team',
          typeName: 'team',
          allowedSurfaces: ['entity'],
          fields: [{ fieldId: 'headcount', fieldType: 'number' }],
        },
      ]),
    );
    renderTab(makeMockClient({ listNamespaces, listEntities, listSchemas }));

    expect(await screen.findByText('Platform Engineering')).toBeInTheDocument();
    await user.click(screen.getByText('Platform Engineering'));

    // Schema-driven field renders via RecordFormFields, disabled.
    const headcountInput = await screen.findByRole('spinbutton', { name: /headcount/i });
    expect(headcountInput).toHaveValue(12);
    expect(headcountInput).toBeDisabled();
  });

  it('still shows the raw payload when a schema IS found, for fields the schema-driven view cannot render', async () => {
    // An array field (RecordFormFields never renders array/object fields —
    // they're raw-only) and an undeclared key: neither's VALUE is visible
    // anywhere except the raw payload. "Never silently dropped" means this
    // dialog must show it even though a schema resolved.
    const user = userEvent.setup();
    const listNamespaces = vi.fn().mockImplementation((req?: { contextId?: string }) =>
      Promise.resolve(
        pageOf(req?.contextId ? [] : [{ namespace: 'team', entityBacked: true, contextId: undefined }]),
      ),
    );
    const listEntities = vi.fn().mockResolvedValue(
      pageOf([
        {
          id: 'ent_1',
          namespace: 'team',
          name: 'Platform Engineering',
          payload: { headcount: 12, members: ['alice', 'bob'], legacyNote: 'from the old system' },
          schemaId: 'schema_team',
        },
      ]),
    );
    const listSchemas = vi.fn().mockResolvedValue(
      pageOf([
        {
          id: 'schema_team',
          typeName: 'team',
          allowedSurfaces: ['entity'],
          fields: [
            { fieldId: 'headcount', fieldType: 'number' },
            { fieldId: 'members', fieldType: 'array' },
          ],
        },
      ]),
    );
    renderTab(makeMockClient({ listNamespaces, listEntities, listSchemas }));

    expect(await screen.findByText('Platform Engineering')).toBeInTheDocument();
    await user.click(screen.getByText('Platform Engineering'));

    await screen.findByRole('spinbutton', { name: /headcount/i });
    // Neither the array field's values nor the undeclared key's value are
    // rendered by the schema-driven view — only the raw payload has them.
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
    expect(screen.getByText(/"members"/)).toBeInTheDocument();
    expect(screen.getByText(/"alice"/)).toBeInTheDocument();
    expect(screen.getByText(/"legacyNote"/)).toBeInTheDocument();
    expect(screen.getByText(/from the old system/)).toBeInTheDocument();
  });

  it('"Load more" fetches the next page and APPENDS it, rather than replacing the first page', async () => {
    const user = userEvent.setup();
    const listNamespaces = vi.fn().mockImplementation((req?: { contextId?: string }) =>
      Promise.resolve(
        pageOf(req?.contextId ? [] : [{ namespace: 'team', entityBacked: true, contextId: undefined }]),
      ),
    );
    const listEntities = vi.fn().mockImplementation((req?: { startFrom?: string }) =>
      Promise.resolve(
        req?.startFrom === 'cursor_1'
          ? { data: [{ id: 'ent_2', namespace: 'team', name: 'Second Entity' }], nextCursor: null }
          : { data: [{ id: 'ent_1', namespace: 'team', name: 'First Entity' }], nextCursor: 'cursor_1' },
      ),
    );
    renderTab(makeMockClient({ listNamespaces, listEntities }));

    expect(await screen.findByText('First Entity')).toBeInTheDocument();
    const loadMore = screen.getByRole('button', { name: /load more/i });

    await user.click(loadMore);

    expect(await screen.findByText('Second Entity')).toBeInTheDocument();
    // The first page's row is still there — appended, not replaced.
    expect(screen.getByText('First Entity')).toBeInTheDocument();
    // The second page's own nextCursor is null — no further "Load more".
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    // Exactly two fetches: the first page (no startFrom) and the second
    // (startFrom: cursor_1) — proves the click is what triggered the refetch.
    expect(listEntities).toHaveBeenCalledTimes(2);
  });

  it('a rejected "Load more" offers Retry, keeps the already-loaded page, and succeeds on retry', async () => {
    const user = userEvent.setup();
    const listNamespaces = vi.fn().mockImplementation((req?: { contextId?: string }) =>
      Promise.resolve(
        pageOf(req?.contextId ? [] : [{ namespace: 'team', entityBacked: true, contextId: undefined }]),
      ),
    );
    let page2Attempts = 0;
    const listEntities = vi.fn().mockImplementation((req?: { startFrom?: string }) => {
      if (req?.startFrom !== 'cursor_1') {
        return Promise.resolve({
          data: [{ id: 'ent_1', namespace: 'team', name: 'First Entity' }],
          nextCursor: 'cursor_1',
        });
      }
      page2Attempts += 1;
      if (page2Attempts === 1) {
        return Promise.reject(new VectrosError({ message: 'down', statusCode: 503 }));
      }
      return Promise.resolve({
        data: [{ id: 'ent_2', namespace: 'team', name: 'Second Entity' }],
        nextCursor: null,
      });
    });
    renderTab(makeMockClient({ listNamespaces, listEntities }));

    expect(await screen.findByText('First Entity')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /load more/i }));

    // Page 2 rejected: the already-loaded first page survives, "Load more"
    // is replaced by Retry (never silently vanishes with no way back in).
    expect(await screen.findByText(/couldn't load the next page/i)).toBeInTheDocument();
    expect(screen.getByText('First Entity')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^load more$/i })).not.toBeInTheDocument();
    // The namespace-level "Could not load entities … Refresh" alert must
    // NOT also render here — that's the first-page-only alert, and showing
    // it alongside Retry would offer two conflicting things to do about one
    // failure (its own copy reads as "discard what's already loaded").
    expect(screen.queryByText(/could not load entities in/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('Second Entity')).toBeInTheDocument();
    expect(screen.getByText('First Entity')).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load the next page/i)).not.toBeInTheDocument();
  });

  it('switching namespace tabs after paging does not carry a stale cursor into the new namespace', async () => {
    const user = userEvent.setup();
    const listNamespaces = vi.fn().mockImplementation((req?: { contextId?: string }) =>
      Promise.resolve(
        pageOf(
          req?.contextId
            ? []
            : [
                { namespace: 'team', entityBacked: true, contextId: undefined },
                { namespace: 'org', entityBacked: true, contextId: undefined },
              ],
        ),
      ),
    );
    const listEntities = vi.fn().mockImplementation((req: { namespace: string; startFrom?: string }) => {
      // A cursor minted for "team" must never be sent on an "org" request —
      // the API itself would reject a cross-query cursor with a 400.
      if (req.namespace === 'org' && req.startFrom) {
        throw new Error('BUG: stale cursor from another namespace leaked into this request');
      }
      if (req.namespace === 'team' && !req.startFrom) {
        return Promise.resolve({
          data: [{ id: 'ent_1', namespace: 'team', name: 'Team Entity' }],
          nextCursor: 'cursor_team_1',
        });
      }
      return Promise.resolve({
        data: [{ id: 'ent_org', namespace: 'org', name: 'Org Entity' }],
        nextCursor: null,
      });
    });
    renderTab(makeMockClient({ listNamespaces, listEntities }));

    expect(await screen.findByText('Team Entity')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(listEntities).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('tab', { name: 'org' }));

    expect(await screen.findByText('Org Entity')).toBeInTheDocument();
    expect(screen.queryByText('Team Entity')).not.toBeInTheDocument();
  });

  it("shows a per-namespace entities error inline, not as a page-wide failure", async () => {
    const listNamespaces = vi.fn().mockImplementation((req?: { contextId?: string }) =>
      Promise.resolve(
        pageOf(
          req?.contextId
            ? []
            : [
                { namespace: 'team', entityBacked: true, contextId: undefined },
              ],
        ),
      ),
    );
    const listEntities = vi.fn().mockRejectedValue(
      new VectrosError({ message: 'Insufficient scope', statusCode: 403, body: {} }),
    );
    renderTab(makeMockClient({ listNamespaces, listEntities }));

    expect(await screen.findByText(/could not load entities in "team"/i)).toBeInTheDocument();
    // The namespace tab strip itself is still there — not a page-wide blowout.
    expect(screen.getByRole('tab', { name: 'team' })).toBeInTheDocument();
  });

  it('falls back to raw JSON when the schema for an entity cannot be resolved', async () => {
    const user = userEvent.setup();
    const listNamespaces = vi.fn().mockImplementation((req?: { contextId?: string }) =>
      Promise.resolve(
        pageOf(req?.contextId ? [] : [{ namespace: 'team', entityBacked: true, contextId: undefined }]),
      ),
    );
    const listEntities = vi.fn().mockResolvedValue(
      pageOf([
        {
          id: 'ent_1',
          namespace: 'team',
          name: 'Platform Engineering',
          payload: { headcount: 12 },
          schemaId: 'schema_missing',
        },
      ]),
    );
    // Schemas call fails outright (e.g. this session lacks schemas:r).
    const listSchemas = vi.fn().mockRejectedValue(
      new VectrosError({ message: 'Insufficient scope', statusCode: 403, body: {} }),
    );
    renderTab(makeMockClient({ listNamespaces, listEntities, listSchemas }));

    await waitFor(() => expect(listSchemas).toHaveBeenCalled());
    await user.click(await screen.findByText('Platform Engineering'));

    expect(await screen.findByText(/schema couldn't be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/"headcount": 12/)).toBeInTheDocument();
  });
});
