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
  return new Response(body === undefined ? '' : JSON.stringify(body), {
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
