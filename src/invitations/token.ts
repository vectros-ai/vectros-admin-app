// ---------------------------------------------------------------------------
// Vectros sub-user invitation token utilities.
//
// The invitation token is a JWT minted by the Vectros backend with the literal
// prefix `inv_` to distinguish it from other token types. The on-the-wire format:
//
//   inv_<base64url-header>.<base64url-payload>.<base64url-signature>
//
// ============================================================================
// CLIENT-SIDE CRYPTOGRAPHIC VERIFICATION.
// ============================================================================
//
// This module performs FULL ES256 signature verification
// against the platform's JWKS endpoint (`GET /v1/auth/jwks`).
// The decoder fetches the JWKS, verifies the signature, validates
// `iss` + `aud`, enforces `exp` (with 30s skew tolerance), and enforces `nbf`
// (with 30s skew tolerance) — all client-side via the `jose` library.
//
// Server-side verification still happens too — the platform's
// PostConfirmation Lambda KMS-verifies the token at signup. The two
// verifications are defense in depth, not duplicative theater: the
// client-side check stops obviously-tampered tokens from rendering the
// signup form at all (UX win + reduces server-side load); the server-side
// check is the ultimate trust boundary that admits the user into the
// platform.
//
// **Fail-closed semantics.** If JWKS fetch fails, decodeInviteToken
// returns `{ kind: 'JWKS_UNAVAILABLE' }` — it does NOT fall back to
// unverified display. The error UI tells the user to try the link again
// or contact their inviter. Falling back to unverified would re-introduce
// the trust-boundary risk this MR specifically removed.
//
// **Partner-fork knob.** Two constants below (`EXPECTED_ISSUER` +
// `EXPECTED_AUDIENCE`) are hardcoded with a "fork to change" comment. The
// JWKS URL is derived from the existing `VITE_VECTROS_API_URL` env var —
// no new config knob; partners that point that env var at their own
// backend automatically get JWKS from there too.
// ---------------------------------------------------------------------------

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload } from 'jose';

import { API_CONFIG } from '../config';

/**
 * The expected `iss` (issuer) claim — Vectros backend constant, mirrored from
 * the backend's invite-token signer. Hardcoded here intentionally — partners forking
 * the Admin App AND using their own backend should change this constant.
 */
const EXPECTED_ISSUER = 'vectros-invite';

/**
 * The expected `aud` (audience) claim. Same provenance as EXPECTED_ISSUER.
 */
const EXPECTED_AUDIENCE = 'vectros-invite-accept';

/** All Vectros invite tokens MUST begin with this prefix. */
const TOKEN_PREFIX = 'inv_';

/**
 * Skew tolerance applied to `exp` + `nbf` claims. 30s is the JWT-ecosystem
 * standard — covers normal clock-drift between client + server without
 * meaningfully widening the attack window. Tokens nearing expiry retry
 * once with the user's clock 30s fast; tokens not-yet-valid by less than
 * 30s are accepted.
 */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Discriminated union returned by decodeInviteToken. The AcceptPage switches
 * on `kind` to pick the right UI state. By returning explicit error variants
 * rather than throwing, the decoder is safe to call with adversarial input.
 *
 * Variant semantics:
 *   - `VALID` — signature verified + all claims accepted.
 *   - `MALFORMED` — token shape is wrong (prefix, segment count, base64,
 *     JSON, or any non-crypto structural problem).
 *   - `INVALID_ISSUER` — `iss` or `aud` claim doesn't match expected
 *     constants. Distinct from MALFORMED so the UI can render specific copy.
 *   - `EXPIRED` — `exp` claim is in the past (beyond skew tolerance).
 *   - `NOT_YET_VALID` — `nbf` claim is in the future (beyond skew
 *     tolerance). Rare in current backend signer behavior but mandated
 *     by the JWT spec ("verifiers SHOULD check nbf").
 *   - `INVALID_SIGNATURE` — JWS signature does not verify against the
 *     JWKS. Most common cause: tampered token. (Other causes: key
 *     rotation in flight, or a JWKS key not yet propagated.)
 *   - `JWKS_UNAVAILABLE` — the JWKS endpoint could not be reached. The
 *     consumer renders a recoverable error message ("try opening the
 *     link again, or contact your inviter").
 */
export type InviteTokenDecodeResult =
  | { readonly kind: 'VALID'; readonly claims: InviteTokenClaims }
  | { readonly kind: 'MALFORMED' }
  | { readonly kind: 'INVALID_ISSUER' }
  | { readonly kind: 'EXPIRED' }
  | { readonly kind: 'NOT_YET_VALID' }
  | { readonly kind: 'INVALID_SIGNATURE' }
  | { readonly kind: 'JWKS_UNAVAILABLE' };

/**
 * The display-safe subset of an invitation token's claims. Only fields the
 * accept page actually renders are surfaced here. Optional fields default to
 * null if not present in the token (defensive — older or partner-customized
 * tokens may omit them).
 */
export interface InviteTokenClaims {
  /** Invitee email — used to pre-fill + LOCK the signup form's email field. */
  readonly email: string;
  /** Inviting organization's display name, or null if not provided. */
  readonly orgName: string | null;
  /** Inviter's display name, or null if not provided. */
  readonly inviterName: string | null;
  /** Expiration timestamp, parsed from the `exp` claim (seconds-since-epoch). */
  readonly expiresAt: Date;
  /**
   * The pre-created backend user-record id this invite resolves to on acceptance.
   * Set by the backend as the JWT `sub` claim when the invite is minted.
   * Seeded into Cognito by AcceptPage as `custom:uuid` so the developer-API
   * can later resolve the sub-user back to their backend user record + bound
   * AccessProfile (mirrors the dev-portal's SPA-seeds-UUID-at-signup pattern
   * used for Dev Admins).
   *
   * **Optional + defensively-nullable** for one specific backward-compat
   * case: tokens minted before this MR's signer change shipped do not
   * carry the claim. Those tokens will still decode VALID; AcceptPage
   * simply skips the `custom:uuid` seeding and the sub-user falls back
   * to the legacy "no developer-API access" state. New invites all carry
   * the claim, so the affected population converges to zero quickly.
   */
  readonly sub: string | null;
}

// ---------------------------------------------------------------------------
// JWKS — module-level lazy cache. jose's createRemoteJWKSet caches the JWKS
// for ~5 minutes by default; wrapping it in a module-scope getter means we
// only construct the resolver once per session even across multiple decode
// calls. The actual network fetch happens on first verify, transparently.
//
// Tests inject a mock by calling `__setJwksResolverForTest()`.
// ---------------------------------------------------------------------------

/** The function jose returns from createRemoteJWKSet, used by jwtVerify. */
type JwksResolver = ReturnType<typeof createRemoteJWKSet>;

let cachedJwksResolver: JwksResolver | null = null;

function getJwksResolver(): JwksResolver {
  if (cachedJwksResolver) return cachedJwksResolver;
  // The JWKS lives at the Vectros API, served by its JWKS handler.
  // Partner forks pointing VITE_VECTROS_API_URL at a different backend
  // automatically pick up the JWKS from there too — same hostname,
  // /v1/auth/jwks path.
  const url = new URL(`${API_CONFIG.vectrosApiBase}/v1/auth/jwks`);
  cachedJwksResolver = createRemoteJWKSet(url);
  return cachedJwksResolver;
}

/**
 * Test-only override for the JWKS resolver. NOT exported from the public
 * surface — tests import this directly. Lets tests substitute a stub
 * resolver without engaging the network.
 */
export function __setJwksResolverForTest(resolver: JwksResolver | null): void {
  cachedJwksResolver = resolver;
}

// ---------------------------------------------------------------------------
// decodeInviteToken — async, JWKS-verified
// ---------------------------------------------------------------------------

/**
 * Decode + cryptographically verify an invitation token.
 *
 * Steps:
 *   1. Strip the `inv_` prefix; validate basic structural shape.
 *   2. Fetch the JWKS (cached for ~5 min by jose internally).
 *   3. Verify the ES256 signature + standard claims (iss, aud, exp, nbf)
 *      via `jose.jwtVerify`, with 30s clock-skew tolerance.
 *   4. Extract the display-safe fields into the InviteTokenClaims shape.
 *
 * NEVER throws. Returns a discriminated union the caller switches on.
 *
 * Why async: signature verification requires the JWKS (network fetch on
 * first call) and Web Crypto API for the ECDSA op. Both are async by
 * nature.
 */
export async function decodeInviteToken(
  rawToken: string,
): Promise<InviteTokenDecodeResult> {
  // ---- Structural pre-checks (cheap, sync-shaped) -----------------------
  if (!rawToken.startsWith(TOKEN_PREFIX)) {
    return { kind: 'MALFORMED' };
  }
  const jwt = rawToken.slice(TOKEN_PREFIX.length);
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { kind: 'MALFORMED' };
  }

  // ---- jose verify (signature + claims + skew tolerance) -----------------
  let payload: JWTPayload;
  try {
    const verifyResult = await jwtVerify(jwt, getJwksResolver(), {
      issuer: EXPECTED_ISSUER,
      audience: EXPECTED_AUDIENCE,
      algorithms: ['ES256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = verifyResult.payload;
  } catch (err) {
    return mapJoseError(err);
  }

  // ---- Extract display-safe claims --------------------------------------
  // `email` — required, must be a non-empty string. After jose verify the
  // standard claims (iss/aud/exp/nbf) are already validated; we only need
  // to spot-check the platform-specific extras.
  const email = payload['email'];
  if (typeof email !== 'string' || email.length === 0) {
    return { kind: 'MALFORMED' };
  }

  // `exp` is guaranteed present + numeric by jose.jwtVerify (it threw
  // otherwise via JWTClaimValidationFailed). Pull it out for the display
  // claim.
  if (typeof payload.exp !== 'number') {
    // Defensive — jose's type permits undefined; in practice exp is
    // present or jose throws. Treat as MALFORMED if somehow absent.
    return { kind: 'MALFORMED' };
  }
  const expiresAt = new Date(payload.exp * 1000);

  // Optional display fields — accept only if string, else null.
  const orgName = typeof payload['orgName'] === 'string' ? payload['orgName'] : null;
  const inviterName =
    typeof payload['inviterName'] === 'string' ? payload['inviterName'] : null;

  // Backend user-record id (sub claim). Optional during the rollout window for
  // tokens minted before the backend's sub-claim shipped; new tokens
  // all carry it. See InviteTokenClaims.sub for backward-compat rationale.
  const sub = typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;

  return {
    kind: 'VALID',
    claims: { email, orgName, inviterName, expiresAt, sub },
  };
}

/**
 * Map a thrown jose error to the corresponding InviteTokenDecodeResult
 * variant. Uses the error's `.code` field (a stable string identifier)
 * rather than `instanceof` because cross-module-boundary instanceof checks
 * are unreliable when bundlers split jose into multiple chunks.
 */
function mapJoseError(err: unknown): InviteTokenDecodeResult {
  if (!(err instanceof Error)) return { kind: 'MALFORMED' };
  // Each jose error class exposes a static `code` field; the instance
  // inherits it.
  const code = (err as { code?: string }).code;

  switch (code) {
    case joseErrors.JWTExpired.code:
      return { kind: 'EXPIRED' };
    case joseErrors.JWTClaimValidationFailed.code: {
      // JWTClaimValidationFailed has a `claim` field naming the failing
      // claim. nbf-not-yet-valid uses this code; iss / aud mismatches do
      // too. Differentiate via the claim name.
      const claim = (err as { claim?: string }).claim;
      if (claim === 'nbf') return { kind: 'NOT_YET_VALID' };
      if (claim === 'iss' || claim === 'aud') return { kind: 'INVALID_ISSUER' };
      return { kind: 'MALFORMED' };
    }
    case joseErrors.JWSSignatureVerificationFailed.code:
      return { kind: 'INVALID_SIGNATURE' };
    case joseErrors.JWKSNoMatchingKey.code:
    case joseErrors.JWKSInvalid.code:
    case joseErrors.JWKSTimeout.code:
      // Any JWKS-fetch / -parse / -timeout failure surfaces as
      // JWKS_UNAVAILABLE. The user can retry; we don't fall back to
      // unverified display.
      return { kind: 'JWKS_UNAVAILABLE' };
    case joseErrors.JWSInvalid.code:
    case joseErrors.JWTInvalid.code:
      return { kind: 'MALFORMED' };
    default:
      // Network-level failures (fetch threw before jose could classify)
      // surface as plain Error instances without a jose-specific code.
      // Treat those as JWKS_UNAVAILABLE — the user's recovery action is
      // the same as for a known JWKS error, and falling through to
      // MALFORMED would mislead the consumer.
      if (err.name === 'TypeError' || err.message?.toLowerCase().includes('fetch')) {
        return { kind: 'JWKS_UNAVAILABLE' };
      }
      return { kind: 'MALFORMED' };
  }
}
