// ---------------------------------------------------------------------------
// Runtime configuration — typed, validated at module load.
//
// Why fail-fast: a missing env var in a production build silently falling
// back to '' makes Amplify throw deep inside its own code with an opaque
// error a developer cannot pattern-match. Throwing here, at module load,
// means the page surfaces a clear "Configuration error" boundary instead.
//
// Cognito User Pool IDs + Client IDs are NOT secrets. They are public
// identifiers — clients hold them, they are reachable by anyone who loads
// the page. Treating them as secrets would not improve security; the only
// secret in the Cognito-SPA model is the user's password (held by Cognito
// itself, never by us).
// ---------------------------------------------------------------------------

function requireEnv(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Configuration error: ${name} is not set. ` +
        `See .env.example for the required variables. ` +
        `In production this is set at build time by the deployment stack.`,
    );
  }
  return value;
}

export interface CognitoConfig {
  /**
   * Cognito User Pool ID, e.g. `us-east-1_ABC123`. The AWS region is encoded
   * as the prefix before the underscore — Amplify v6 derives it from the
   * pool ID, so no separate region field is needed in this config.
   */
  readonly userPoolId: string;
  /** Cognito User Pool App Client ID — scoped per subdomain. */
  readonly userPoolClientId: string;
}

export const COGNITO_CONFIG: CognitoConfig = {
  userPoolId: requireEnv('VITE_COGNITO_USER_POOL_ID'),
  userPoolClientId: requireEnv('VITE_COGNITO_USER_POOL_CLIENT_ID'),
};

/**
 * API endpoint configuration for the two-stage auth bridge:
 *   - `developerApiBase` — the Cognito-gated developer API. Admin-app calls
 *     `GET ${developerApiBase}/developer/scoped-token` to mint a partner-
 *     API st_* bearer (unified handler: Dev Admin → wildcard,
 *     sub-user → AccessProfile-bound scope).
 *   - `vectrosApiBase` — the Vectros API the minted st_* unlocks. All
 *     /v1/* admin-app traffic (Members, Keys, Logs) routes through here.
 *
 * For staging both URLs typically resolve to the same host (api.staging.
 * vectros.ai); they are split into two env vars so a partner fork or a
 * future split-domain deployment can point them at different origins.
 */
export interface ApiConfig {
  readonly developerApiBase: string;
  readonly vectrosApiBase: string;
}

export const API_CONFIG: ApiConfig = {
  developerApiBase: requireEnv('VITE_DEVELOPER_API_URL'),
  vectrosApiBase: requireEnv('VITE_VECTROS_API_URL'),
};
