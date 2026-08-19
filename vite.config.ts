/// <reference types="vitest" />
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// ---------------------------------------------------------------------------
// versionManifest — bakes a build id into the bundle and emits it as a small
// `version.json` next to index.html. The client (VersionUpdateBanner) polls
// that manifest and compares it against the baked id to detect a newer deploy.
//
// The id is the short git SHA (overridable via APP_BUILD_ID for build systems
// without a git checkout). In the dev server it is left as 'dev' so the banner
// disables itself — there is nothing to poll against locally.
// ---------------------------------------------------------------------------
function versionManifest(): Plugin {
  let buildId = 'dev';
  let outDir = 'dist';
  const resolveId = (): string => {
    if (process.env.APP_BUILD_ID) return process.env.APP_BUILD_ID;
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return 'dev';
    }
  };
  return {
    name: 'version-manifest',
    config(_config, env) {
      buildId = env.command === 'build' ? resolveId() : 'dev';
      if (env.command === 'build' && buildId === 'dev') {
        // A production build with no resolvable id ships with version-skew
        // detection OFF (banner disabled, no version.json). Surface it loudly.
        console.warn(
          '[version-manifest] no build id (git rev-parse failed and APP_BUILD_ID unset) — ' +
            'version.json will NOT be emitted and the update banner is disabled for this build.',
        );
      }
      return { define: { __APP_VERSION__: JSON.stringify(buildId) } };
    },
    configResolved(resolved) {
      outDir = resolved.build.outDir;
    },
    closeBundle() {
      if (buildId === 'dev') return;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'version.json'), `${JSON.stringify({ version: buildId })}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Vite + Vitest configuration for the Vectros Admin App.
//
// Dev server pinned to port 3001 so it coexists with ui/developer-portal on
// 3000 during local dev. `strictPort: true` makes a port collision a hard
// failure (instead of silently incrementing) so developers notice + fix it
// rather than launching against an unexpected URL the Cognito allow-list
// hasn't been updated for.
//
// Source maps in production builds: ENABLED. We ship a strict CSP that
// blocks third-party scripts, so the .map files are only useful to anyone
// who can already read source. The tradeoff is debuggability of
// production errors >> the negligible obfuscation gain of stripping maps.
//
// optimizeDeps.include — MUI icons are individually exported as separate
// modules (`@mui/icons-material/Edit`, `.../Add`, etc.). Vite's default
// behavior discovers them lazily on first request, triggers a re-bundle,
// and FORCES A PAGE RELOAD when new ones land. That reload disrupts any
// in-flight page state — and crucially trips a brief window where Amplify's
// session-restore hasn't completed, so RequireAuth bounces to /login.
//
// We saw this manifest in a smoke run (2026-05-30): every protected
// page test failed on the first run (the run that triggered the new-icon
// optimization mid-test); the second run passed because the optimization
// was now cached in `node_modules/.vite/`. The fix is to pre-include the
// icons so Vite warms them at startup, before the first test request.
//
// CI implication: CI containers start with no `.vite/` cache, so they
// would hit this on EVERY run. `retries: 1` in playwright.config masks
// some of the flake but not all. This config fix makes the behavior
// deterministic across local + CI.
//
// Maintenance: when a new icon import is added, list it here. The icon
// names below are derived from `grep -rh "from '@mui/icons-material/'"
// ui/admin-app/src`. A future ergonomic fix (Vite ≥ 7? or a custom
// plugin) could glob-include `@mui/icons-material/*` automatically;
// not worth the abstraction for v1.
// ---------------------------------------------------------------------------

export default defineConfig({
  plugins: [react(), versionManifest()],
  resolve: {
    alias: {
      // Consume @vectros-ai/react as its BUILT bundle (one module) — matches what
      // tsc reads (dist/index.d.ts). Importing the src tree instead pulled the
      // whole package + its dep graph into every vitest file (ballooning import
      // time → userEvent timing flakes) and loaded a 2nd @types/react. Run
      // `npm run build -w @vectros-ai/react` after changing the lib (tsup --watch
      // during active dev). Swapped for a registry pin at the public-release cut.
      // The lib ships CognitoAuthProvider/Auth0AuthProvider as SEPARATE entry
      // points (not re-exported as values from the main bundle — see that
      // package's tsup.config.ts), so each subpath needs its own alias. Listed
      // BEFORE the bare '@vectros-ai/react' entry below: Vite/Rollup's alias
      // matching is prefix-based, so the more specific key must be checked
      // first or it's shadowed by the shorter one matching as a prefix.
      // admin-app only ever constructs CognitoAuthProvider; the auth0 subpath
      // has no alias here since nothing in this app imports it.
      '@vectros-ai/react/providers/cognito': fileURLToPath(
        new URL('../../packages/react/dist/auth/providers/cognito.mjs', import.meta.url),
      ),
    },
    // The lib declares these as peer deps; with a source alias the app and the
    // (workspace-installed) lib would otherwise resolve two copies. That breaks
    // two ways: duplicate React/Query/Intl instances lose shared context
    // ("invalid hook call"; missing provider), and a duplicate aws-amplify/jose
    // means a test's `vi.mock(...)` targets a different copy than the lib imports.
    // Force a single instance of every shared runtime dependency.
    dedupe: [
      'react',
      'react-dom',
      '@mui/material',
      '@mui/icons-material',
      '@emotion/react',
      '@emotion/styled',
      '@tanstack/react-query',
      'react-intl',
      'react-router',
      'aws-amplify',
      'jose',
      'qrcode.react',
      '@vectros-ai/sdk',
    ],
  },
  optimizeDeps: {
    include: [
      '@mui/icons-material/AccountCircle',
      '@mui/icons-material/Add',
      '@mui/icons-material/AdminPanelSettings',
      '@mui/icons-material/Article',
      '@mui/icons-material/BarChart',
      '@mui/icons-material/ContentCopy',
      '@mui/icons-material/DeleteOutline',
      '@mui/icons-material/Edit',
      '@mui/icons-material/ExpandLess',
      '@mui/icons-material/ExpandMore',
      '@mui/icons-material/ForwardToInbox',
      '@mui/icons-material/Home',
      '@mui/icons-material/InfoOutlined',
      '@mui/icons-material/Menu',
      '@mui/icons-material/People',
      '@mui/icons-material/Person',
      '@mui/icons-material/Refresh',
      '@mui/icons-material/Search',
      '@mui/icons-material/SmartToy',
      '@mui/icons-material/Visibility',
      '@mui/icons-material/VisibilityOff',
      '@mui/icons-material/VpnKey',
    ],
  },
  server: {
    port: 3001,
    strictPort: true,
    host: '127.0.0.1',
  },
  preview: {
    port: 3001,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Bail loud on accidental large bundles — surface them in PR review,
    // not in post-deploy CDN-bill autopsies.
    chunkSizeWarningLimit: 600,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Headroom over the 5s default: each test file transitively imports the
    // @vectros-ai/react bundle (→ aws-amplify), a heavy parse, so userEvent-driven
    // form tests can exceed 5s on a contended runner. Generous timeout removes the
    // false timeouts without masking real failures (assertion errors still fail).
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
});
