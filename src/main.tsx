// ---------------------------------------------------------------------------
// Application entry point.
//
// Responsibilities (in order):
//   1. Validate runtime config (throws at module load if env is incomplete).
//   2. Configure Amplify against the Cognito User Pool.
//   3. Install global unhandled-rejection / error logging — these complement
//      the React ErrorBoundary (which catches render-phase errors) by
//      catching async/Promise errors that React does not see.
//   4. Set the document title from BRAND so re-skins don't require touching
//      index.html.
//   5. Mount the React tree under StrictMode + ErrorBoundary +
//      QueryClientProvider (TanStack Query) + IntlProvider + ThemeProvider.
// ---------------------------------------------------------------------------

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { BrowserRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import App from './App';
import {
  AuthProvider,
  CognitoAuthProvider,
  CurrentTenantProvider,
  setPartnerApiTokenMinter,
} from './auth';
import { COGNITO_CONFIG, API_CONFIG } from './config';
import { BRAND } from './brand';
import { ErrorBoundary, VersionUpdateBanner } from '@vectros-ai/react';
import { theme } from './theme';
import { IntlProvider } from './i18n/IntlProvider';
import { createQueryClient } from './lib/queryClient';

// Module-level QueryClient singleton — one cache for the app lifetime.
// Tests instantiate fresh per-test clients via createQueryClient(); see
// src/test/intl.tsx for the wrapper that provides one to each render.
const queryClient = createQueryClient();

// 1. Config validated by importing it (requireEnv throws on missing values).

// 2. Configure Amplify. We pass only the Cognito identity-provider settings;
//    the Admin App does not use Amplify Storage / API / DataStore. The AWS
//    region is encoded in the userPoolId (e.g. `us-east-1_ABC` → us-east-1)
//    and Amplify v6 derives it automatically — no separate region field.
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: COGNITO_CONFIG.userPoolId,
      userPoolClientId: COGNITO_CONFIG.userPoolClientId,
    },
  },
});

// 3. Global async error logging. Render-phase errors are caught by
//    ErrorBoundary; this covers everything else.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection', event.reason);
});
window.addEventListener('error', (event) => {
  console.error('Uncaught error', event.error ?? event.message);
});

// 4. Brand-driven document title (re-skins via src/brand.ts only).
document.title = BRAND.productName;

// 5. Instantiate the auth-provider adapter. To swap providers in a fork,
//    change THIS line (and the matching import). Everything downstream
//    depends only on the AuthProviderAdapter interface in src/auth/types.ts.
const authProvider = new CognitoAuthProvider({
  developerApiBase: API_CONFIG.developerApiBase,
  productName: BRAND.productName,
});

// 5a. Wire the partner-API token cache's minter to the just-instantiated
//     adapter. The cache (consumed by axios interceptors — non-React code that
//     can't read `useAuth()`) stays provider-agnostic: it knows nothing about
//     how a partner-API bearer is minted. CognitoAuthProvider.mintPartnerApiToken
//     does the Vectros-specific work (developer-API scoped-token). A fork
//     swaps the provider above + wires its own minter here. Done before React
//     mounts so the first partner-API call never races this registration.
//
//     The admin app's control-plane pages (members, scoped keys, logs) live in
//     the reserved `vectros-admin` AppContext, so their bearers must be minted
//     in that context explicitly — an un-contexted mint resolves to the base
//     `default` context, which has no control-plane access profile (→ 404s on
//     /members etc.). The context-scoped pages (an app context's detail, roles,
//     and access profiles) DO supply a context: a bearer pinned to one context
//     may act only within it, so reading or editing another context requires a
//     bearer minted for THAT context. The cache passes the caller's requested
//     contextId through here; we default it to the control-plane context only
//     when the caller asked for no specific one.
const CONTROL_PLANE_CONTEXT = 'vectros-admin';
setPartnerApiTokenMinter((tenantId, contextId) =>
  authProvider.mintPartnerApiToken(tenantId, contextId ?? CONTROL_PLANE_CONTEXT),
);

// Build id baked in by the versionManifest() plugin in vite.config.ts. The
// `typeof` guard keeps this a safe read if the define ever fails to apply —
// it falls back to a non-deploy id so the banner simply disables itself
// rather than throwing a ReferenceError at module load.
const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;

// 6. Mount.
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/*
      ErrorBoundary intentionally lives OUTSIDE IntlProvider so the boundary
      can still render if react-intl itself fails to mount (catalog import
      error, etc.). ErrorBoundary's copy is hardcoded English + BRAND
      interpolation — a safety net for the safety net.
    */}
    <ErrorBoundary supportEmail={BRAND.supportEmail}>
      {/*
        QueryClientProvider sits inside ErrorBoundary so render errors from
        Query-driven components are caught by the same safety net, but
        OUTSIDE IntlProvider/ThemeProvider/Router so the cache is available
        to every consumer regardless of theming/intl/route boundaries.
        ReactQueryDevtools mounts only in dev (Vite's import.meta.env.DEV
        is statically false in prod → dead-code-eliminated from the bundle).
      */}
      <QueryClientProvider client={queryClient}>
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
        <IntlProvider>
          <ThemeProvider theme={theme}>
            <CssBaseline />
            {/*
              App-wide, route-independent: polls version.json and offers a
              user-initiated refresh when a newer build is deployed, so a
              long-open tab never strands on a stale shell (a pruned lazy chunk
              would otherwise 404). Inside ThemeProvider for MUI theming;
              outside the Router since it is not route-scoped.
            */}
            <VersionUpdateBanner currentVersion={APP_VERSION} />
            <BrowserRouter>
              <AuthProvider provider={authProvider}>
                {/*
                  CurrentTenantProvider is inside AuthProvider because it reads
                  memberships from the auth adapter (and on switch, refreshes the
                  JWT + re-keys the partner-API token cache).
                */}
                <CurrentTenantProvider>
                  <App />
                </CurrentTenantProvider>
              </AuthProvider>
            </BrowserRouter>
          </ThemeProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
