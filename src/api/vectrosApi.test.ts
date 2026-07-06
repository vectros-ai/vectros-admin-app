// ---------------------------------------------------------------------------
// vectrosApi tests — the per-(tenant, context) client factory.
//
// Pins the contract the context-scoped pages depend on:
//   - One cached client instance per (tenant, context) pair; the same arguments
//     return the same instance, and a different context (or the no-context
//     control-plane call) gets its own.
//   - The SDK's bearer-token Supplier threads the contextId through to the token
//     cache, so a context-scoped page mints a bearer for ITS context (a bearer
//     pinned to another context would 403), while the no-context call mints the
//     default control-plane bearer.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factories (themselves hoisted) can close over them.
const { getVectrosApiToken, ctorOpts } = vi.hoisted(() => ({
  getVectrosApiToken: vi.fn<(tenantId: string, contextId?: string) => Promise<string>>(),
  ctorOpts: [] as Array<{ token: () => Promise<string> }>,
}));

vi.mock('../auth', () => ({ getVectrosApiToken }));
vi.mock('../config', () => ({
  API_CONFIG: { vectrosApiBase: 'https://api.example.com', developerApiBase: 'https://api.example.com' },
}));

// Capture each VectrosClient construction so we can inspect the token Supplier.
vi.mock('@vectros-ai/sdk', () => ({
  VectrosClient: class {
    constructor(opts: { token: () => Promise<string> }) {
      ctorOpts.push(opts);
    }
  },
  VectrosError: class {},
  VectrosTimeoutError: class {},
  Vectros: {},
}));

import { vectrosApiClient, __resetVectrosApiClientCacheForTest } from './vectrosApi';

const TENANT = 'tnt_abc';

getVectrosApiToken.mockResolvedValue('st_token');

afterEach(() => {
  __resetVectrosApiClientCacheForTest();
  ctorOpts.length = 0;
  getVectrosApiToken.mockClear();
  getVectrosApiToken.mockResolvedValue('st_token');
});

describe('vectrosApiClient caching', () => {
  it('returns the same instance for the same (tenant, context)', () => {
    expect(vectrosApiClient(TENANT, 'engineering')).toBe(vectrosApiClient(TENANT, 'engineering'));
    expect(ctorOpts).toHaveLength(1);
  });

  it('returns distinct instances per context, and the no-context call is its own', () => {
    const a = vectrosApiClient(TENANT, 'engineering');
    const b = vectrosApiClient(TENANT, 'marketing');
    const none = vectrosApiClient(TENANT);
    expect(a).not.toBe(b);
    expect(a).not.toBe(none);
    expect(ctorOpts).toHaveLength(3);
  });
});

describe('vectrosApiClient token threading', () => {
  it('threads the contextId to the token cache for a context-scoped client', async () => {
    vectrosApiClient(TENANT, 'engineering');
    await ctorOpts[0]!.token();
    expect(getVectrosApiToken).toHaveBeenCalledWith(TENANT, 'engineering');
  });

  it('passes no context for the control-plane client', async () => {
    vectrosApiClient(TENANT);
    await ctorOpts[0]!.token();
    expect(getVectrosApiToken).toHaveBeenCalledWith(TENANT, undefined);
  });
});
