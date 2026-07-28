// ---------------------------------------------------------------------------
// wireTokenMinter tests.
//
// Exercises the real setPartnerApiTokenMinter → vectrosApiTokenCache chain
// (no mocking of @vectros-ai/react) so this proves the actual wired behavior,
// not a restatement of it. Regression target: a stale `contextId ?? 'vectros-
// admin'` default once shipped here, breaking every un-parameterized
// control-plane call after login — the backend now rejects an explicit mint
// for that reserved context outright.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetVectrosApiTokenCacheForTest,
  getVectrosApiToken,
} from '@vectros-ai/react';
import type { CognitoAuthProvider } from '@vectros-ai/react';

import { wirePartnerApiTokenMinter } from './wireTokenMinter';

beforeEach(() => {
  __resetVectrosApiTokenCacheForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('wirePartnerApiTokenMinter', () => {
  it('passes a caller-supplied contextId through to mintPartnerApiToken unchanged', async () => {
    const mintPartnerApiToken = vi
      .fn()
      .mockResolvedValue({ token: 'st_ctx', expiresAtMs: Date.now() + 900_000 });
    wirePartnerApiTokenMinter({ mintPartnerApiToken } as unknown as CognitoAuthProvider);

    await getVectrosApiToken('tnt_test', 'some-context');

    expect(mintPartnerApiToken).toHaveBeenCalledWith('tnt_test', 'some-context');
  });

  it('mints against the caller-omitted context as undefined — never falls back to a default context', async () => {
    const mintPartnerApiToken = vi
      .fn()
      .mockResolvedValue({ token: 'st_default', expiresAtMs: Date.now() + 900_000 });
    wirePartnerApiTokenMinter({ mintPartnerApiToken } as unknown as CognitoAuthProvider);

    await getVectrosApiToken('tnt_test');

    expect(mintPartnerApiToken).toHaveBeenCalledWith('tnt_test', undefined);
    expect(mintPartnerApiToken).not.toHaveBeenCalledWith('tnt_test', 'vectros-admin');
  });
});
