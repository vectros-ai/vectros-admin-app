// ---------------------------------------------------------------------------
// Wires the partner-API token cache's minter to a CognitoAuthProvider
// instance. Extracted out of main.tsx — which mounts the whole app tree at
// module load and is excluded from coverage for exactly that reason — so
// this one line has a unit test. It broke once already (a stale
// `contextId ?? 'vectros-admin'` default the backend now rejects outright);
// see wireTokenMinter.test.ts.
// ---------------------------------------------------------------------------

import { setPartnerApiTokenMinter } from '@vectros-ai/react';
import type { CognitoAuthProvider } from '@vectros-ai/react';

/**
 * No default context override: an un-contexted mint resolves to the base
 * `default` context, which is exactly what every un-parameterized caller
 * needs. The owner's token carries wildcard `allowed_actions` regardless of
 * which context it's pinned to, and none of admin-app's un-parameterized
 * calls (the nav's scope-gate check, Usage) read context-partitioned data —
 * Usage is a tenant-wide model, and Keys/Logs/the Contexts list have their
 * own owner-gated developer-API routes that need no partner-API bearer at
 * all. The context-scoped pages (an app context's detail, roles, and access
 * profiles) supply their own explicit contextId, which passes through here
 * unchanged. The reserved `vectros-admin` context is deliberately never
 * targeted by this app: it's a non-data-bearing control marker, and the
 * partner API rejects an explicit mint request for it outright.
 */
export function wirePartnerApiTokenMinter(authProvider: CognitoAuthProvider): void {
  setPartnerApiTokenMinter((tenantId, contextId) =>
    authProvider.mintPartnerApiToken(tenantId, contextId),
  );
}
