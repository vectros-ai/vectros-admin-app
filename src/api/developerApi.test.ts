// ---------------------------------------------------------------------------
// developerApi tests — the owner-gated control-plane client.
//
// Pins the wire contract the page relies on:
//   - GET/POST hit `/developer/app-contexts` with the tenant kind, the id token
//     as a bearer, and (for list) the pagination params.
//   - The `{ data, nextCursor }` page envelope and the created-context body are
//     returned as-is.
//   - A non-2xx throws DeveloperApiError carrying `statusCode` + the server's
//     `{ message, requestId }` envelope (so the request-id correlation line
//     surfaces), degrading gracefully when the body is empty or not JSON.
//   - A missing session surfaces as a 401 in the same shape, without a fetch.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDeveloperApi,
  DeveloperApiError,
  type TenantKind,
} from './developerApi';

function jsonResponse(body: unknown, status = 200): Response {
  // Null body (not '') for the empty-body accepts — 204 rejects a non-null body.
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as Response;
}

function makeApi(opts: { token?: string | null; tenant?: TenantKind } = {}) {
  return createDeveloperApi({
    baseUrl: 'https://api.example.com/',
    tenant: opts.tenant ?? 'test',
    getIdToken: vi.fn().mockResolvedValue(opts.token === undefined ? 'id-token-xyz' : opts.token),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('createDeveloperApi.listAppContexts', () => {
  it('GETs the app-contexts route with the tenant + bearer and returns the page', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ contextId: 'engineering' }], nextCursor: null }));
    vi.stubGlobal('fetch', fetchSpy);

    const page = await makeApi({ tenant: 'live' }).listAppContexts();

    expect(page).toEqual({ data: [{ contextId: 'engineering' }], nextCursor: null });
    const [url, init] = fetchSpy.mock.calls[0]!;
    // Trailing slash on the base URL is collapsed (no `//developer`).
    expect(url).toBe('https://api.example.com/developer/app-contexts?tenant=live');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer id-token-xyz');
  });

  it('passes startFrom + limit as query params when given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ data: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchSpy);

    await makeApi().listAppContexts('cursor-1', 100);

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('tenant=test');
    expect(url).toContain('startFrom=cursor-1');
    expect(url).toContain('limit=100');
  });
});

describe('createDeveloperApi.createAppContext', () => {
  it('POSTs the body with the tenant + bearer and returns the created context', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ contextId: 'taskflow', name: 'TaskFlow' }, 201));
    vi.stubGlobal('fetch', fetchSpy);

    const created = await makeApi().createAppContext({ contextId: 'taskflow', name: 'TaskFlow' });

    expect(created).toEqual({ contextId: 'taskflow', name: 'TaskFlow' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/developer/app-contexts?tenant=test');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ contextId: 'taskflow', name: 'TaskFlow' });
  });
});

describe('createDeveloperApi.deleteAppContext', () => {
  it('DELETEs the context route with the tenant + the confirm echo + bearer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(undefined, 202));
    vi.stubGlobal('fetch', fetchSpy);

    await makeApi({ tenant: 'live' }).deleteAppContext('engineering');

    const [url, init] = fetchSpy.mock.calls[0]!;
    // The server's irreversible-operation contract: the contextId rides the
    // path AND is echoed back as `confirm`.
    expect(url).toBe(
      'https://api.example.com/developer/app-contexts/engineering?tenant=live&confirm=engineering',
    );
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer id-token-xyz');
  });

  it('resolves on the 202 empty-body accept', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(undefined, 202)));
    await expect(makeApi().deleteAppContext('engineering')).resolves.toBeUndefined();
  });

  it('throws DeveloperApiError with the envelope on a rejected delete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Not authorized', requestId: 'req_9' }, 403)),
    );
    await expect(makeApi().deleteAppContext('vectros-admin')).rejects.toMatchObject({
      name: 'DeveloperApiError',
      statusCode: 403,
      body: { message: 'Not authorized', requestId: 'req_9' },
    });
  });
});

describe('createDeveloperApi.listScopedKeys', () => {
  it('GETs the scoped-keys route with the bearer and unwraps the page data', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { keyId: 'ssk_a', contextId: 'prod-intake', tenantId: 'tnt_live' },
          { keyId: 'ssk_b', contextId: 'vectros-admin', tenantId: 'tnt_test' },
        ],
        nextCursor: null,
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const keys = await makeApi().listScopedKeys();

    // Cross-context + cross-tenant — the account-wide view, unwrapped from the envelope.
    expect(keys.map((k) => k.keyId)).toEqual(['ssk_a', 'ssk_b']);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/developer/scoped-keys');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer id-token-xyz');
  });

  it('returns [] when the page has no data array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ nextCursor: null })));
    await expect(makeApi().listScopedKeys()).resolves.toEqual([]);
  });
});

describe('createDeveloperApi.revokeScopedKey', () => {
  it('DELETEs the keyId route with the bearer and resolves on the 204', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(undefined, 204));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(makeApi().revokeScopedKey('ssk_data_ctx')).resolves.toBeUndefined();

    const [url, init] = fetchSpy.mock.calls[0]!;
    // Revoke by id — no context in the path; the server finds it across contexts.
    expect(url).toBe('https://api.example.com/developer/scoped-keys/ssk_data_ctx');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer id-token-xyz');
  });

  it('URL-encodes the keyId', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(undefined, 204));
    vi.stubGlobal('fetch', fetchSpy);
    await makeApi().revokeScopedKey('a/b c');
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.example.com/developer/scoped-keys/a%2Fb%20c');
  });

  it('throws DeveloperApiError on a rejected revoke', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Key not found', requestId: 'req_k' }, 404)),
    );
    await expect(makeApi().revokeScopedKey('nope')).rejects.toMatchObject({
      name: 'DeveloperApiError',
      statusCode: 404,
      body: { message: 'Key not found', requestId: 'req_k' },
    });
  });
});

describe('createDeveloperApi.getAdminLogs', () => {
  it('is tenant-wide by default: GETs /developer/logs with tenant + startTime and NO contextId', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ entries: [], truncated: false, queryDurationMs: 12, tenantId: 'tnt_test' }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const res = await makeApi().getAdminLogs({ startTime: '2025-01-15T09:00:00Z' });

    expect(res.tenantId).toBe('tnt_test');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain('/developer/logs?');
    expect(url).toContain('tenant=test');
    expect(url).toContain('startTime=2025-01-15T09%3A00%3A00Z');
    // Omitting contextId is the account-wide view — no context filter is sent.
    expect(url).not.toContain('contextId=');
    expect(init.headers.Authorization).toBe('Bearer id-token-xyz');
  });

  it('sends contextId + the other filters when supplied', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ entries: [], truncated: false, queryDurationMs: 3, tenantId: 'tnt_live' }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await makeApi({ tenant: 'live' }).getAdminLogs({
      startTime: '2025-01-15T09:00:00Z',
      endTime: '2025-01-15T10:00:00Z',
      resource: 'documents',
      method: 'POST',
      keyId: 'key_1',
      contextId: 'prod-intake',
      errorsOnly: true,
      limit: 50,
    });

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('tenant=live');
    expect(url).toContain('contextId=prod-intake');
    expect(url).toContain('resource=documents');
    expect(url).toContain('method=POST');
    expect(url).toContain('keyId=key_1');
    expect(url).toContain('errorsOnly=true');
    expect(url).toContain('limit=50');
  });
});

describe('createDeveloperApi error handling', () => {
  it('throws DeveloperApiError carrying statusCode + message + requestId on a non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'Not authorized', requestId: 'req_42' }, 403)),
    );

    await expect(makeApi().listAppContexts()).rejects.toMatchObject({
      name: 'DeveloperApiError',
      statusCode: 403,
      message: 'Not authorized',
      body: { message: 'Not authorized', requestId: 'req_42' },
    });
  });

  it('degrades gracefully when the error body is empty or not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>gateway error</html>', { status: 502 }) as unknown as Response),
    );

    const err = await makeApi()
      .listAppContexts()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeveloperApiError);
    expect((err as DeveloperApiError).statusCode).toBe(502);
    // No requestId to surface — the body wasn't the JSON envelope.
    expect((err as DeveloperApiError).body.requestId).toBeUndefined();
  });

  it('surfaces a 401 (without fetching) when there is no session', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(makeApi({ token: null }).listAppContexts()).rejects.toMatchObject({
      name: 'DeveloperApiError',
      statusCode: 401,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
