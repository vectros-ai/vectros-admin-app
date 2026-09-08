// ---------------------------------------------------------------------------
// vectrosApiTokenCache tests — (tenant, context)-keyed + injected minter.
//
// What we pin:
//   1. Mint-on-miss via the INJECTED minter (no hardcoded endpoint here).
//   2. Cache hit / refresh-before-expiry.
//   3. Per-tenant independence (minting tenant A doesn't pollute tenant B).
//   4. Concurrent-mint coalescing per tenant (N callers → 1 mint); no
//      coalescing across tenants.
//   5. In-flight slot released after success + after failure (retry works).
//   6. Clear-during-mint generation defense: clear() between mint start and
//      resolution → result discarded; cache stays clear.
//   7. Minter not registered → clear error.
//
// The minter is a plain injected function, so tests script it directly — no
// global fetch stubbing needed (that detail now lives in the auth provider).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetVectrosApiTokenCacheForTest,
  clearVectrosApiTokenCache,
  getVectrosApiToken,
  setPartnerApiTokenMinter,
} from '@vectros-ai/react';
import type { PartnerApiTokenMinter } from '@vectros-ai/react';

const TENANT_A = 'tnt_aaaaaaaa';
const TENANT_B = 'tnt_bbbbbbbb';

beforeEach(() => {
  __resetVectrosApiTokenCacheForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A minter that returns `token`, expiring `ttlMs` from now (default 15 min). */
function mintReturning(token: string, ttlMs = 900_000): PartnerApiTokenMinter {
  return vi.fn(async () => ({ token, expiresAtMs: Date.now() + ttlMs }));
}

describe('vectrosApiTokenCache', () => {
  describe('happy path', () => {
    it('mints via the injected minter when the cache is empty', async () => {
      const minter = mintReturning('st_first');
      setPartnerApiTokenMinter(minter);

      const token = await getVectrosApiToken(TENANT_A);

      expect(token).toBe('st_first');
      expect(minter).toHaveBeenCalledTimes(1);
      // contextId is omitted (admin-app's tenant-only path) → passed as undefined.
      expect(minter).toHaveBeenCalledWith(TENANT_A, undefined);
    });

    it('returns the cached token without a re-mint on subsequent calls', async () => {
      const minter = mintReturning('st_cached');
      setPartnerApiTokenMinter(minter);

      const a = await getVectrosApiToken(TENANT_A);
      const b = await getVectrosApiToken(TENANT_A);

      expect(a).toBe('st_cached');
      expect(b).toBe('st_cached');
      expect(minter).toHaveBeenCalledTimes(1);
    });

    it('re-mints when the cached token is within the refresh-before-expiry window', async () => {
      // First mint expires in 30s — inside the 60s refresh window → next call re-mints.
      setPartnerApiTokenMinter(mintReturning('st_short', 30_000));
      const first = await getVectrosApiToken(TENANT_A);
      expect(first).toBe('st_short');

      const refreshed = mintReturning('st_refreshed');
      setPartnerApiTokenMinter(refreshed);
      const second = await getVectrosApiToken(TENANT_A);
      expect(second).toBe('st_refreshed');
      expect(refreshed).toHaveBeenCalledTimes(1);
    });

    it('rejects an empty tenantId with a clear error', async () => {
      setPartnerApiTokenMinter(mintReturning('st_x'));
      await expect(getVectrosApiToken('')).rejects.toThrow(/tenantId is required/);
    });
  });

  describe('per-tenant independence', () => {
    it('caches each tenant separately — minting A does not satisfy B', async () => {
      const minter = vi.fn(async (tenantId: string) => ({
        token: tenantId === TENANT_A ? 'st_a' : 'st_b',
        expiresAtMs: Date.now() + 900_000,
      }));
      setPartnerApiTokenMinter(minter);

      expect(await getVectrosApiToken(TENANT_A)).toBe('st_a');
      expect(await getVectrosApiToken(TENANT_B)).toBe('st_b');
      // One mint per tenant.
      expect(minter).toHaveBeenCalledTimes(2);
      // A again is cached — no third mint.
      expect(await getVectrosApiToken(TENANT_A)).toBe('st_a');
      expect(minter).toHaveBeenCalledTimes(2);
    });
  });

  describe('per-context independence', () => {
    const CTX_A = 'ctx-alpha';
    const CTX_B = 'ctx-beta';

    it('caches each (tenant, context) slot separately and passes contextId to the minter', async () => {
      const minter = vi.fn(async (tenantId: string, contextId?: string) => ({
        token: `st_${tenantId}_${contextId ?? 'default'}`,
        expiresAtMs: Date.now() + 900_000,
      }));
      setPartnerApiTokenMinter(minter);

      // Same tenant, two different contexts → two distinct slots, two mints.
      expect(await getVectrosApiToken(TENANT_A, CTX_A)).toBe(`st_${TENANT_A}_${CTX_A}`);
      expect(await getVectrosApiToken(TENANT_A, CTX_B)).toBe(`st_${TENANT_A}_${CTX_B}`);
      expect(minter).toHaveBeenCalledTimes(2);
      expect(minter).toHaveBeenCalledWith(TENANT_A, CTX_A);
      expect(minter).toHaveBeenCalledWith(TENANT_A, CTX_B);

      // Re-request CTX_A → cached, no third mint.
      expect(await getVectrosApiToken(TENANT_A, CTX_A)).toBe(`st_${TENANT_A}_${CTX_A}`);
      expect(minter).toHaveBeenCalledTimes(2);
    });

    it('keeps the tenant-only slot distinct from a (tenant, context) slot', async () => {
      const minter = vi.fn(async (tenantId: string, contextId?: string) => ({
        token: `st_${tenantId}_${contextId ?? 'none'}`,
        expiresAtMs: Date.now() + 900_000,
      }));
      setPartnerApiTokenMinter(minter);

      expect(await getVectrosApiToken(TENANT_A)).toBe(`st_${TENANT_A}_none`);
      expect(await getVectrosApiToken(TENANT_A, CTX_A)).toBe(`st_${TENANT_A}_${CTX_A}`);
      expect(minter).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent callers for the same (tenant, context) into one mint', async () => {
      const minter = vi.fn(async (_tenantId: string, contextId?: string) => ({
        token: `st_${contextId}`,
        expiresAtMs: Date.now() + 900_000,
      }));
      setPartnerApiTokenMinter(minter);

      const results = await Promise.all([
        getVectrosApiToken(TENANT_A, CTX_A),
        getVectrosApiToken(TENANT_A, CTX_A),
      ]);
      expect(results).toEqual([`st_${CTX_A}`, `st_${CTX_A}`]);
      expect(minter).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent-mint coalescing', () => {
    it('coalesces concurrent callers for the same tenant into one mint', async () => {
      const minter = mintReturning('st_shared');
      setPartnerApiTokenMinter(minter);

      const results = await Promise.all([
        getVectrosApiToken(TENANT_A),
        getVectrosApiToken(TENANT_A),
        getVectrosApiToken(TENANT_A),
      ]);

      expect(results).toEqual(['st_shared', 'st_shared', 'st_shared']);
      expect(minter).toHaveBeenCalledTimes(1);
    });

    it('does NOT coalesce across tenants', async () => {
      const minter = vi.fn(async (tenantId: string) => ({
        token: `st_${tenantId}`,
        expiresAtMs: Date.now() + 900_000,
      }));
      setPartnerApiTokenMinter(minter);

      await Promise.all([getVectrosApiToken(TENANT_A), getVectrosApiToken(TENANT_B)]);
      expect(minter).toHaveBeenCalledTimes(2);
    });

    it('releases the in-flight slot after a failed mint so a retry can succeed', async () => {
      setPartnerApiTokenMinter(
        vi.fn(async () => {
          throw new Error('network down');
        }),
      );
      await expect(getVectrosApiToken(TENANT_A)).rejects.toThrow('network down');

      setPartnerApiTokenMinter(mintReturning('st_recovered'));
      await expect(getVectrosApiToken(TENANT_A)).resolves.toBe('st_recovered');
    });
  });

  describe('clear-during-mint generation defense', () => {
    it('discards the mint result if clearVectrosApiTokenCache fires mid-flight', async () => {
      // The promise is created EAGERLY, before the minter is even called — not
      // inside the minter's own body. getVectrosApiToken's internal mint IIFE
      // yields once (an unconditional `await Promise.resolve()`, load-bearing —
      // see that module's own comment) before it ever invokes the minter, so a
      // `resolveMint` assigned lazily INSIDE the minter body wouldn't exist yet
      // by the time this test's own synchronous code below tries to call it.
      let resolveMint!: (v: { token: string; expiresAtMs: number }) => void;
      const mintPromise = new Promise<{ token: string; expiresAtMs: number }>((resolve) => {
        resolveMint = resolve;
      });
      setPartnerApiTokenMinter(vi.fn(() => mintPromise));

      const pending = getVectrosApiToken(TENANT_A);
      pending.catch(() => undefined); // pre-attach so the rejection isn't "unhandled"

      // Logout mid-flight.
      clearVectrosApiTokenCache();

      // Mint resolves AFTER the clear — must be discarded.
      resolveMint({ token: 'st_stale_identity', expiresAtMs: Date.now() + 900_000 });
      await expect(pending).rejects.toThrow(/Session cleared during/);

      // Cache stayed clear — next call mints fresh.
      const fresh = mintReturning('st_fresh');
      setPartnerApiTokenMinter(fresh);
      expect(await getVectrosApiToken(TENANT_A)).toBe('st_fresh');
      expect(fresh).toHaveBeenCalledTimes(1);
    });

    it('clears every tenant (a shared-session logout invalidates all)', async () => {
      setPartnerApiTokenMinter(
        vi.fn(async (t: string) => ({ token: `st_${t}_1`, expiresAtMs: Date.now() + 900_000 })),
      );
      await getVectrosApiToken(TENANT_A);
      await getVectrosApiToken(TENANT_B);

      clearVectrosApiTokenCache();

      const second = vi.fn(async (t: string) => ({
        token: `st_${t}_2`,
        expiresAtMs: Date.now() + 900_000,
      }));
      setPartnerApiTokenMinter(second);
      expect(await getVectrosApiToken(TENANT_A)).toBe(`st_${TENANT_A}_2`);
      expect(await getVectrosApiToken(TENANT_B)).toBe(`st_${TENANT_B}_2`);
      expect(second).toHaveBeenCalledTimes(2);
    });
  });

  describe('error paths', () => {
    it('throws a clear error if the minter was never registered', async () => {
      // beforeEach's reset un-registers the minter.
      await expect(getVectrosApiToken(TENANT_A)).rejects.toThrow(/minter not registered/);
    });

    it('propagates the minter error verbatim', async () => {
      setPartnerApiTokenMinter(
        vi.fn(async () => {
          throw new Error('mint failed: 401 expired');
        }),
      );
      await expect(getVectrosApiToken(TENANT_A)).rejects.toThrow(/401 expired/);
    });
  });
});
