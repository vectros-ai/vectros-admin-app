import { describe, expect, it } from 'vitest';

import { classifyVerifyRefusal } from './issuerVerifyRefusal';

class FakeApiError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

describe('classifyVerifyRefusal', () => {
  it('classifies the full refusal-message table into the right next action', () => {
    const cases: Array<[string, ReturnType<typeof classifyVerifyRefusal>['action']]> = [
      ["The token does not carry the 'https://vectros.ai/claims/issuer_challenge' claim. Configure your IdP to add it.", 'reconfigure-the-identity-provider'],
      ["The token's 'https://vectros.ai/claims/issuer_challenge' claim must be a string.", 'reconfigure-the-identity-provider'],
      ["The token's 'https://vectros.ai/claims/issuer_challenge' claim does not match this registration's verificationNonce.", 'retry-with-a-new-token'],
      ['The token was not issued for this registration\'s issuer.', 'retry-with-a-new-token'],
      ["The token's audience does not include this registration's audience.", 'retry-with-a-new-token'],
      ["'token' is required.", 'retry-with-a-new-token'],
      ["'token' must be a JWT: a signed, compact-serialized token your identity provider issued.", 'retry-with-a-new-token'],
      ["The token could not be verified against the issuer's key set: its signature, expiry, issuer or audience did not check out.", 'retry-with-a-new-token'],
      ["The issuer's OpenID Connect discovery document could not be fetched from https://evil.example.com/.well-known/openid-configuration.", 'fix-the-identity-providers-discovery-document'],
      ['issuer must use the https:// scheme to be verified.', 'fix-the-identity-providers-discovery-document'],
      ["The issuer's discovery document names a different issuer than the one registered.", 'fix-the-identity-providers-discovery-document'],
      ["jwksUri does not match the jwks_uri this issuer publishes ('https://evil.example.com/jwks.json'). A registration can only be verified against the issuer's own key set.", 'fix-the-identity-providers-discovery-document'],
      ["This registration's verification challenge has expired. Delete it and register the issuer again to get a new one.", 're-register-the-issuer'],
      ['This (issuer, audience) pair is already registered by another registration. Use a distinct audience per environment/context sharing one IdP account.', 'resolve-a-conflicting-registration'],
      ["App context 'default' already has an active issuer registered. A context may have exactly one active IdP — deregister the existing one first if you need to replace it.", 'resolve-a-conflicting-registration'],
      ['This registration is not awaiting verification.', 'reload-and-recheck-the-row'],
      [
        "contextId 'default' does not name an existing app context in your tenant.",
        'app-context-unavailable',
      ],
    ];

    for (const [message, expected] of cases) {
      expect(classifyVerifyRefusal(new FakeApiError(400, message)).action).toBe(expected);
    }
  });

  it('classifies by status code for 403/404/409, regardless of message', () => {
    expect(classifyVerifyRefusal(new FakeApiError(403, 'Forbidden')).action).toBe('not-authorized');
    expect(classifyVerifyRefusal(new FakeApiError(404, 'Issuer not found: idp-a')).action).toBe(
      'reload-and-recheck-the-row',
    );
    expect(
      classifyVerifyRefusal(
        new FakeApiError(409, 'This registration changed or was removed while it was being verified. Retry.'),
      ).action,
    ).toBe('reload-and-recheck-the-row');
  });

  it('classifies any 5xx (e.g. a gateway timeout on the two-outbound-fetch proof) as reload-and-recheck', () => {
    expect(classifyVerifyRefusal(new FakeApiError(504, 'Endpoint request timed out')).action).toBe(
      'reload-and-recheck-the-row',
    );
    expect(classifyVerifyRefusal(new FakeApiError(500, 'Internal error')).action).toBe(
      'reload-and-recheck-the-row',
    );
  });

  it('falls back to "unknown" for an unrecognized message, preserving it for display', () => {
    const refusal = classifyVerifyRefusal(new FakeApiError(400, 'Something new the UI has never seen.'));
    expect(refusal.action).toBe('unknown');
    expect(refusal.message).toBe('Something new the UI has never seen.');
  });

  it('handles a plain Error with no statusCode, and a bare string', () => {
    expect(classifyVerifyRefusal(new Error('network down')).action).toBe('unknown');
    expect(classifyVerifyRefusal('nope').message).toBe('nope');
  });
});
