// ---------------------------------------------------------------------------
// issuerVerifyRefusal — maps a failed verify call to the next action an
// operator should actually take.
//
// The verify endpoint refuses for a wide range of reasons, and they are NOT
// interchangeable: some mean "paste a fresh token and try again," some mean
// "reconfigure the identity provider, then retry," some mean "this can't be
// fixed from here at all — re-register the issuer," and some mean "nothing
// you did was wrong, just try again." A single generic "verification failed"
// message would flatten all of that into a dead end, so every refusal this
// endpoint is documented to return is classified into one of a small set of
// next actions below. Anything NOT recognized falls back to the raw message
// with a neutral retry hint, rather than guessing.
// ---------------------------------------------------------------------------

export type VerifyRefusalAction =
  /** A fresh, correctly-formed token from a real sign-in should work. */
  | 'retry-with-a-new-token'
  /** The identity provider's own rule/mapping needs to be fixed before any token from it will work. */
  | 'reconfigure-the-identity-provider'
  /** The identity provider's discovery document (not this form) is the problem. */
  | 'fix-the-identity-providers-discovery-document'
  /** Not fixable by retrying verification at all — the registration itself must be replaced. */
  | 're-register-the-issuer'
  /** The app context this issuer belongs to is gone or being torn down — no token can fix that. */
  | 'app-context-unavailable'
  /** Someone else (or something else) already holds what this registration needs. */
  | 'resolve-a-conflicting-registration'
  /** The row's state moved; re-read it before doing anything else. */
  | 'reload-and-recheck-the-row'
  /** The caller isn't allowed to do this at all. */
  | 'not-authorized'
  /** Nothing recognized; show the raw message. */
  | 'unknown';

export interface VerifyRefusal {
  readonly action: VerifyRefusalAction;
  readonly message: string;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Verification failed.';
}

function statusOf(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'statusCode' in error
    ? (error as { statusCode?: number }).statusCode
    : undefined;
}

/** Ordered rules, most-specific first — the first substring match wins. Matched against the exact
 *  refusal prose the endpoint is documented to return. */
const RULES: ReadonlyArray<{ test: (m: string) => boolean; action: VerifyRefusalAction }> = [
  { test: (m) => m.includes('verification challenge has expired'), action: 're-register-the-issuer' },
  {
    test: (m) => m.includes('does not name an existing app context'),
    action: 'app-context-unavailable',
  },
  {
    test: (m) => m.includes('already registered by another registration') || m.includes('already has an active issuer'),
    action: 'resolve-a-conflicting-registration',
  },
  { test: (m) => m.includes('not awaiting verification'), action: 'reload-and-recheck-the-row' },
  {
    test: (m) =>
      m.includes('could not be fetched') ||
      m.includes('must use the https') ||
      m.includes('names a different issuer') ||
      m.includes('not valid json') ||
      m.includes("does not name an 'issuer'") ||
      m.includes('not a valid url') ||
      m.includes('jwks_uri') ||
      m.includes('jwksuri'),
    action: 'fix-the-identity-providers-discovery-document',
  },
  {
    test: (m) => m.includes('does not carry the') || m.includes('claim must be a string'),
    action: 'reconfigure-the-identity-provider',
  },
  {
    test: (m) => m.includes("does not match this registration's verificationnonce"),
    action: 'retry-with-a-new-token',
  },
  {
    test: (m) => m.includes('not issued for this registration') || m.includes('audience does not include'),
    action: 'retry-with-a-new-token',
  },
  {
    test: (m) => m.includes("'token' is required") || m.includes("'token' must be a jwt"),
    action: 'retry-with-a-new-token',
  },
  {
    test: (m) => m.includes('could not be verified against the'),
    action: 'retry-with-a-new-token',
  },
];

/** Classify a failed {@link import('../../api/developerApi').DeveloperApi.verifyIssuer} call into the
 *  next action an operator should take, using the endpoint's HTTP status first and its documented
 *  refusal prose second. */
export function classifyVerifyRefusal(error: unknown): VerifyRefusal {
  const message = messageOf(error);
  const status = statusOf(error);

  if (status === 403) return { action: 'not-authorized', message };
  if (status === 404) return { action: 'reload-and-recheck-the-row', message };
  if (status === 409) return { action: 'reload-and-recheck-the-row', message };
  // A verify call can genuinely run long (it makes up to two outbound fetches against the identity
  // provider), so a gateway/server timeout is a real, reachable outcome here, not just a hypothetical.
  // The outcome on the server is unknown from a timeout alone, so "reload and recheck" is the safe
  // guidance rather than a blind "retry" that could double-submit against a request that's still
  // in flight.
  if (status !== undefined && status >= 500) return { action: 'reload-and-recheck-the-row', message };

  const lower = message.toLowerCase();
  const rule = RULES.find((r) => r.test(lower));
  return { action: rule?.action ?? 'unknown', message };
}
