// ---------------------------------------------------------------------------
// MemberDetailPage tests.
//
// Pinning:
//   1. Loading + identity summary fields render from getUser.
//   2. The usr_<id> principal is shown.
//   3. Schema-aware payload rendering (RecordFormFields, disabled) + the
//      raw payload ALWAYS also rendered.
//   4. No schema resolved → raw-only fallback, with the right reason text
//      (not found vs. couldn't load).
//   5. Cross-context profiles render via the OWNER-gated developer route;
//      a SUB_USER sees the "requires OWNER access" message instead.
//   6. Load error on getUser.
// ---------------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestIntlProvider } from '../../test/intl';
import { pageOf } from '../../test/pageOf';
import { vectrosApiClient, VectrosError } from '../../api/vectrosApi';
import type * as VectrosApi from '../../api/vectrosApi';
import { useDeveloperApi } from '../../api/developerApi';
import type * as DeveloperApi from '../../api/developerApi';
import { TestTenantProvider, TEST_MEMBERSHIPS } from '../../test/TestTenantProvider';
import { MemberDetailPage } from './MemberDetailPage';

vi.mock('../../api/vectrosApi', async (importOriginal) => {
  const actual = await importOriginal<typeof VectrosApi>();
  return { ...actual, vectrosApiClient: vi.fn() };
});

vi.mock('../../api/developerApi', async (importOriginal) => {
  const actual = await importOriginal<typeof DeveloperApi>();
  return { ...actual, useDeveloperApi: vi.fn() };
});

const ALICE = {
  id: 'u_alice',
  email: 'alice@example.com',
  externalId: 'ext-alice',
  status: 'ACTIVE',
  type: 'HUMAN',
  externalSubject: 'sub-alice',
  createdAt: '2026-05-15T08:00:00Z',
  payload: {},
};

function makeMockClient(
  overrides: {
    getUser?: ReturnType<typeof vi.fn>;
    listSchemas?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    identity: {
      getUser: overrides.getUser ?? vi.fn().mockResolvedValue(ALICE),
    },
    schemas: {
      listSchemas: overrides.listSchemas ?? vi.fn().mockResolvedValue(pageOf([])),
    },
  };
}

function makeMockDeveloperApi(
  overrides: { listUserProfiles?: ReturnType<typeof vi.fn> } = {},
) {
  return {
    listUserProfiles: overrides.listUserProfiles ?? vi.fn().mockResolvedValue(pageOf([])),
  };
}

function renderPage(
  opts: {
    client?: ReturnType<typeof makeMockClient>;
    devApi?: ReturnType<typeof makeMockDeveloperApi>;
    memberships?: typeof TEST_MEMBERSHIPS;
    id?: string;
  } = {},
) {
  const client = opts.client ?? makeMockClient();
  const devApi = opts.devApi ?? makeMockDeveloperApi();
  vi.mocked(vectrosApiClient).mockReturnValue(client as never);
  vi.mocked(useDeveloperApi).mockReturnValue(devApi as never);
  const utils = render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[`/members/${opts.id ?? 'u_alice'}`]}>
        <TestTenantProvider kind="live" {...(opts.memberships ? { memberships: opts.memberships } : {})}>
          <Routes>
            <Route path="/members/:id" element={<MemberDetailPage />} />
          </Routes>
        </TestTenantProvider>
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { ...utils, client, devApi };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('MemberDetailPage', () => {
  it('renders the identity summary from getUser', async () => {
    renderPage();
    // The email appears twice (breadcrumb + h1 title) — assert presence, not uniqueness.
    expect((await screen.findAllByText('alice@example.com')).length).toBeGreaterThan(0);
    expect(screen.getByText('usr_u_alice')).toBeInTheDocument();
    expect(screen.getByText('ext-alice')).toBeInTheDocument();
    expect(screen.getByText('sub-alice')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Human')).toBeInTheDocument();
  });

  it('shows a load error when getUser fails', async () => {
    const err = new VectrosError({ message: 'not found', statusCode: 404 });
    renderPage({ client: makeMockClient({ getUser: vi.fn().mockRejectedValue(err) }) });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('renders the payload schema-aware (RecordFormFields, disabled) when the user carries a schemaId', async () => {
    const listSchemas = vi.fn().mockResolvedValue(
      pageOf([
        {
          id: 'schema_agent',
          typeName: 'agentProfile',
          allowedSurfaces: ['user'],
          fields: [{ fieldId: 'seatCount', fieldType: 'number' }],
        },
      ]),
    );
    const withSchema = { ...ALICE, schemaId: 'schema_agent', payload: { seatCount: 4 } };
    renderPage({
      client: makeMockClient({ getUser: vi.fn().mockResolvedValue(withSchema), listSchemas }),
    });

    const seatInput = await screen.findByRole('spinbutton', { name: /seatCount/i });
    expect(seatInput).toHaveValue(4);
    expect(seatInput).toBeDisabled();

    // The raw payload is ALWAYS also rendered.
    expect(screen.getByText(/"seatCount": 4/)).toBeInTheDocument();
  });

  it('falls back to raw-only with a "no schema" reason when schemaId is absent', async () => {
    renderPage({
      client: makeMockClient({
        getUser: vi.fn().mockResolvedValue({ ...ALICE, payload: { note: 'hi' } }),
      }),
    });
    expect(await screen.findByText(/no schema was found/i)).toBeInTheDocument();
    expect(screen.getByText(/"note": "hi"/)).toBeInTheDocument();
  });

  it('falls back to raw-only with a "couldn\'t load" reason when the schemas call fails', async () => {
    const withSchema = { ...ALICE, schemaId: 'schema_agent', payload: { note: 'hi' } };
    renderPage({
      client: makeMockClient({
        getUser: vi.fn().mockResolvedValue(withSchema),
        listSchemas: vi.fn().mockRejectedValue(new VectrosError({ message: 'boom', statusCode: 403 })),
      }),
    });
    expect(await screen.findByText(/schema couldn't be loaded/i)).toBeInTheDocument();
  });

  it('OWNER: renders every context the member holds a profile in', async () => {
    const listUserProfiles = vi.fn().mockResolvedValue(
      pageOf([
        { id: 'p1', contextId: 'default', principalId: 'usr_u_alice', roleId: 'tmpl-owner' },
        { id: 'p2', contextId: 'billing', principalId: 'usr_u_alice', roleId: 'tmpl-billing' },
      ]),
    );
    renderPage({ devApi: makeMockDeveloperApi({ listUserProfiles }) });

    expect(await screen.findByRole('link', { name: 'default' })).toHaveAttribute(
      'href',
      '/access/contexts/default/profiles/usr_u_alice',
    );
    expect(screen.getByRole('link', { name: 'billing' })).toHaveAttribute(
      'href',
      '/access/contexts/billing/profiles/usr_u_alice',
    );
  });

  it('SUB_USER: shows the cross-context-unavailable message instead of guessing', async () => {
    const listUserProfiles = vi.fn().mockResolvedValue(pageOf([]));
    renderPage({
      devApi: makeMockDeveloperApi({ listUserProfiles }),
      memberships: [{ ...TEST_MEMBERSHIPS[0]!, role: 'SUB_USER' }],
    });
    expect(await screen.findByText(/requires owner access/i)).toBeInTheDocument();
    expect(listUserProfiles).not.toHaveBeenCalled();
  });
});
