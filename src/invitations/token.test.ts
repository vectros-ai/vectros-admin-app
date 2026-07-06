// ---------------------------------------------------------------------------
// decodeInviteToken tests — covers structural pre-checks, every jose-thrown
// error variant, and the post-verify claim normalization.
//
// jose is mocked partially: jwtVerify + createRemoteJWKSet are stubbed per
// test; the real error classes are kept (via importOriginal) so the
// decoder's `.code` switch works against actual jose error codes. Each
// test sets jwtVerify's resolved/rejected value to drive the decoder
// through the variant under test.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errors as joseErrors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

import { decodeInviteToken, __setJwksResolverForTest } from './token';

// Partial mock — keep real error classes (so their `.code` static fields
// match what the decoder switches on) but stub the verify + JWKS resolver.
// vi.mock is hoisted by the test runner, so the `jwtVerify` import above
// resolves to the mocked function regardless of statement order in source.
vi.mock('jose', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: vi.fn(),
    createRemoteJWKSet: vi.fn(() => ({})),
  };
});

const mockVerify = vi.mocked(jwtVerify);

/**
 * Build a structurally-valid raw inv_* token string. Content is opaque —
 * jose is mocked, so the body doesn't have to be a real JWT.
 */
function rawToken(): string {
  return 'inv_aGVhZGVy.cGF5bG9hZA.c2ln';
}

/**
 * Build a JWTPayload matching what jose.jwtVerify would return for a valid
 * token. Apply overrides to test specific extraction paths.
 */
function payload(overrides: Partial<JWTPayload> & Record<string, unknown> = {}): JWTPayload {
  return {
    iss: 'vectros-invite',
    aud: 'vectros-invite-accept',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    email: 'invitee@example.com',
    ...overrides,
  } as JWTPayload;
}

/**
 * Build a jose-like error with the given code + optional claim. The
 * decoder reads .code + .claim via property access (no instanceof checks),
 * so plain Error subclasses with the right shape work cleanly here.
 */
function joseError(code: string, claim?: string): Error {
  const err = new Error(`mock: ${code}`);
  (err as Error & { code: string; claim?: string }).code = code;
  if (claim) (err as Error & { claim: string }).claim = claim;
  return err;
}

beforeEach(() => {
  mockVerify.mockReset();
  // Force a fresh JWKS resolver build each test so the mocked
  // createRemoteJWKSet hook is engaged consistently.
  __setJwksResolverForTest(null);
});

// ---------------------------------------------------------------------------
// Structural pre-checks — these short-circuit BEFORE jose runs.
// ---------------------------------------------------------------------------

describe('decodeInviteToken — structural pre-checks (jose never engaged)', () => {
  it('returns MALFORMED for empty string', async () => {
    const result = await decodeInviteToken('');
    expect(result).toEqual({ kind: 'MALFORMED' });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('returns MALFORMED for missing inv_ prefix', async () => {
    const result = await decodeInviteToken('eyJhbGc.eyJ.sig');
    expect(result).toEqual({ kind: 'MALFORMED' });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('returns MALFORMED for only the prefix', async () => {
    expect(await decodeInviteToken('inv_')).toEqual({ kind: 'MALFORMED' });
  });

  it('returns MALFORMED for wrong segment count', async () => {
    expect(await decodeInviteToken('inv_one.two')).toEqual({ kind: 'MALFORMED' });
    expect(await decodeInviteToken('inv_one.two.three.four')).toEqual({ kind: 'MALFORMED' });
  });

  it('returns MALFORMED for empty payload segment', async () => {
    expect(await decodeInviteToken('inv_h..sig')).toEqual({ kind: 'MALFORMED' });
  });

  it('returns MALFORMED for empty signature segment', async () => {
    // Defense-in-depth — jose would also reject; we catch it earlier.
    expect(await decodeInviteToken('inv_h.p.')).toEqual({ kind: 'MALFORMED' });
  });
});

// ---------------------------------------------------------------------------
// jose-error mapping — every variant.
// ---------------------------------------------------------------------------

describe('decodeInviteToken — EXPIRED', () => {
  it('returns EXPIRED when jose throws JWTExpired', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWTExpired.code));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'EXPIRED' });
  });
});

describe('decodeInviteToken — NOT_YET_VALID', () => {
  it('returns NOT_YET_VALID when jose throws JWTClaimValidationFailed with claim=nbf', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWTClaimValidationFailed.code, 'nbf'));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'NOT_YET_VALID' });
  });
});

describe('decodeInviteToken — INVALID_ISSUER', () => {
  it('returns INVALID_ISSUER when jose throws JWTClaimValidationFailed with claim=iss', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWTClaimValidationFailed.code, 'iss'));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'INVALID_ISSUER' });
  });

  it('returns INVALID_ISSUER when jose throws JWTClaimValidationFailed with claim=aud', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWTClaimValidationFailed.code, 'aud'));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'INVALID_ISSUER' });
  });

  it('returns MALFORMED for JWTClaimValidationFailed with an unknown claim (defensive)', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWTClaimValidationFailed.code, 'jti'));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'MALFORMED' });
  });
});

describe('decodeInviteToken — INVALID_SIGNATURE', () => {
  it('returns INVALID_SIGNATURE when jose throws JWSSignatureVerificationFailed', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWSSignatureVerificationFailed.code));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'INVALID_SIGNATURE' });
  });
});

describe('decodeInviteToken — JWKS_UNAVAILABLE', () => {
  it('returns JWKS_UNAVAILABLE when jose throws JWKSNoMatchingKey', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWKSNoMatchingKey.code));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'JWKS_UNAVAILABLE' });
  });

  it('returns JWKS_UNAVAILABLE when jose throws JWKSInvalid', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWKSInvalid.code));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'JWKS_UNAVAILABLE' });
  });

  it('returns JWKS_UNAVAILABLE when jose throws JWKSTimeout', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWKSTimeout.code));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'JWKS_UNAVAILABLE' });
  });

  it('returns JWKS_UNAVAILABLE on raw fetch failure (TypeError, no jose code)', async () => {
    const err = new TypeError('Failed to fetch');
    mockVerify.mockRejectedValue(err);
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'JWKS_UNAVAILABLE' });
  });

  it('returns JWKS_UNAVAILABLE on generic fetch error message (no jose code)', async () => {
    const err = new Error('Network request to fetch JWKS failed');
    mockVerify.mockRejectedValue(err);
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'JWKS_UNAVAILABLE' });
  });
});

describe('decodeInviteToken — MALFORMED via jose-side parse failures', () => {
  it('returns MALFORMED when jose throws JWSInvalid', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWSInvalid.code));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'MALFORMED' });
  });

  it('returns MALFORMED when jose throws JWTInvalid', async () => {
    mockVerify.mockRejectedValue(joseError(joseErrors.JWTInvalid.code));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'MALFORMED' });
  });

  it('returns MALFORMED for an unknown jose error code (defensive)', async () => {
    mockVerify.mockRejectedValue(joseError('ERR_NOT_A_JOSE_THING_WE_KNOW_ABOUT'));
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'MALFORMED' });
  });

  it('returns MALFORMED for a non-Error rejection (defensive — shouldn\'t happen, but)', async () => {
    // jose always rejects with Error subclasses; if a non-Error somehow
    // surfaces (e.g. a polyfill issue), fall through to MALFORMED.
    mockVerify.mockRejectedValue('not an error');
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'MALFORMED' });
  });
});

// ---------------------------------------------------------------------------
// VALID — post-verify claim normalization
// ---------------------------------------------------------------------------

describe('decodeInviteToken — VALID', () => {
  it('returns VALID with email + expiresAt + null optional fields', async () => {
    mockVerify.mockResolvedValue({ payload: payload(), protectedHeader: { alg: 'ES256' } } as never);
    const result = await decodeInviteToken(rawToken());
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') return;
    expect(result.claims.email).toBe('invitee@example.com');
    expect(result.claims.orgName).toBeNull();
    expect(result.claims.inviterName).toBeNull();
    expect(result.claims.sub).toBeNull();
    expect(result.claims.expiresAt).toBeInstanceOf(Date);
    expect(result.claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns VALID with sub claim populated', async () => {
    mockVerify.mockResolvedValue({
      payload: payload({ sub: 'usr-uuid-1234' }),
      protectedHeader: { alg: 'ES256' },
    } as never);
    const result = await decodeInviteToken(rawToken());
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') return;
    expect(result.claims.sub).toBe('usr-uuid-1234');
  });

  it('drops non-string sub to null (defensive)', async () => {
    mockVerify.mockResolvedValue({
      payload: payload({ sub: 42 as unknown as string }),
      protectedHeader: { alg: 'ES256' },
    } as never);
    const result = await decodeInviteToken(rawToken());
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') return;
    expect(result.claims.sub).toBeNull();
  });

  it('drops empty-string sub to null (defensive)', async () => {
    mockVerify.mockResolvedValue({
      payload: payload({ sub: '' }),
      protectedHeader: { alg: 'ES256' },
    } as never);
    const result = await decodeInviteToken(rawToken());
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') return;
    expect(result.claims.sub).toBeNull();
  });

  it('returns VALID with optional fields populated', async () => {
    mockVerify.mockResolvedValue({
      payload: payload({
        email: 'alice@example.com',
        orgName: 'Acme Inc.',
        inviterName: 'Bob Smith',
      }),
      protectedHeader: { alg: 'ES256' },
    } as never);
    const result = await decodeInviteToken(rawToken());
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') return;
    expect(result.claims.email).toBe('alice@example.com');
    expect(result.claims.orgName).toBe('Acme Inc.');
    expect(result.claims.inviterName).toBe('Bob Smith');
  });

  it('handles UTF-8 in display claims', async () => {
    mockVerify.mockResolvedValue({
      payload: payload({ orgName: 'Café León', inviterName: 'Zoë' }),
      protectedHeader: { alg: 'ES256' },
    } as never);
    const result = await decodeInviteToken(rawToken());
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') return;
    expect(result.claims.orgName).toBe('Café León');
    expect(result.claims.inviterName).toBe('Zoë');
  });

  it('drops non-string optional fields to null (defensive)', async () => {
    mockVerify.mockResolvedValue({
      payload: payload({ orgName: 42, inviterName: { name: 'x' } }),
      protectedHeader: { alg: 'ES256' },
    } as never);
    const result = await decodeInviteToken(rawToken());
    expect(result.kind).toBe('VALID');
    if (result.kind !== 'VALID') return;
    expect(result.claims.orgName).toBeNull();
    expect(result.claims.inviterName).toBeNull();
  });

  it('returns MALFORMED when post-verify email is missing (defensive)', async () => {
    mockVerify.mockResolvedValue({
      payload: payload({ email: undefined }),
      protectedHeader: { alg: 'ES256' },
    } as never);
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'MALFORMED' });
  });

  it('returns MALFORMED when post-verify email is non-string (defensive)', async () => {
    mockVerify.mockResolvedValue({
      payload: payload({ email: 123 as unknown as string }),
      protectedHeader: { alg: 'ES256' },
    } as never);
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'MALFORMED' });
  });

  it('returns MALFORMED when post-verify exp is missing (defensive)', async () => {
    // jose enforces exp presence + numeric — this branch is defense in
    // depth in case a future jose version relaxes that contract.
    // Build a payload WITHOUT exp (exactOptionalPropertyTypes makes
    // `exp: undefined` invalid; we delete the key instead).
    const noExp = payload();
    delete (noExp as { exp?: number }).exp;
    mockVerify.mockResolvedValue({
      payload: noExp,
      protectedHeader: { alg: 'ES256' },
    } as never);
    expect(await decodeInviteToken(rawToken())).toEqual({ kind: 'MALFORMED' });
  });
});
