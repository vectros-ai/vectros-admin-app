# Vectros Admin App

The production admin UI for the Vectros AI platform, **and** the canonical
reference example for developers building their own admin app on top of the
[Vectros API](https://docs.vectros.ai).

Fork it. Re-brand it in one file. Point it at your own Cognito pool. Ship.

---

## What's in the box

| Capability | Implementation note |
|---|---|
| Member management | Invite, re-invite, and remove team members; per-member access-profile visibility with batch loading that distinguishes "no profile" from a lookup failure. |
| Scoped API keys | List and revoke, plus a guided five-step create wizard (user → key name → contexts → roles → review). |
| App contexts, roles & access profiles | Create/edit/delete data contexts; per-context role and access-profile editors with role cloning and reference-aware deletes. |
| Named platform capabilities (`granted_capabilities`) | Role, access-profile, and scoped-key editors can grant `member-lifecycle` and `delegate-mint` alongside the ordinary `allowed_actions`/`data_scope` clause — the two of the platform's four named capabilities this app's own session can back (a capability grant can only name what the granting session's own credential already holds; `forensic-read` and `context-directory-read` are tenant-wide and served by dedicated server-side endpoints instead, never by a browser session). The key-creation wizard surfaces the `delegate-mint` requirement up front when binding a key to someone other than yourself, not just as a late 403. |
| Activity logs | API call history with time-range presets and resource/method/key filters (explicit-fetch gated — the backing log query is metered). |
| Usage & credits | The account usage report: credits against your plan, a per-category breakdown, read metering, and live/test + per-context decompositions. |
| Cognito authentication + MFA | Amplify v6 against the shared DeveloperUserPool; TOTP enrollment and management on the Account page. Single Cognito identity per email across both the Dev Portal and this Admin App. |
| Sub-user invitation acceptance | `/accept?t=<token>` verifies the invite token client-side against the API's JWKS endpoint (display is never trusted unverified), then runs Cognito self-signup with the `custom:invite_token` attribute. A PostConfirmation hook activates the membership server-side. |
| Live/Test environment switcher | Every list and mutation keys on the active tenant; switching re-mints the API bearer. |
| Scope-gated navigation | Nav items and routes share one action map (`billing:r`, `admin:users`, …) read from the session token's scope, so links and route guards can never drift. |
| Theming + branding | Single-file re-skin via [`src/brand.ts`](src/brand.ts). |
| Strict CSP + security headers | Set at the CloudFront edge in the reference deployment (S3 + CloudFront); bring your own hosting stack and mirror the posture in the Security model below. |

## Stack

| Layer | Choice | Why |
|---|---|---|
| Build | [Vite 8](https://vitejs.dev/) | Modern, maintained, replaces deprecated CRA. |
| Language | TypeScript 5 (strict, `noUncheckedIndexedAccess`) | Types our SDK integration; catches whole classes of bugs at compile time. |
| Auth | [aws-amplify](https://docs.amplify.aws/) v6 | Cognito SDK with auto-refresh + MFA + reset-password flows. |
| UI | [MUI v7](https://mui.com/) | Accessible component library; one design system (no Tailwind mixed in). |
| State | React Context (auth) + TanStack Query (server state) | No Redux. Auth/session is Context; all API reads/writes go through TanStack Query for caching + invalidation. |
| Routing | `react-router` v7 | |
| Tests | [Vitest](https://vitest.dev/) 4 + [Testing Library](https://testing-library.com/) + jsdom | Pairs natively with Vite. |
| Lint | ESLint 9 flat config + `typescript-eslint` + `jsx-a11y` + `react-hooks` | A11y rules are enforced, not advisory. |

## Quick start (local development)

Prerequisites: Node 20+ (see [`.nvmrc`](.nvmrc)), npm 10+.

```bash
npm install
cp .env.example .env.local           # fill in your Cognito pool + API origin
npm run dev                          # dev server on port 3001
```

> [!NOTE]
> Working inside the Vectros monorepo (not a fork)? This app consumes the
> shared [`@vectros-ai/react`](https://github.com/vectros-ai/vectros-react)
> library as its **built dist** via a workspace alias — build it first, and
> again after changing it: `npm run build -w @vectros-ai/react` from the
> monorepo root. In a standalone fork the library resolves from npm and no
> extra step is needed.

Open http://127.0.0.1:3001.

> [!NOTE]
> The dev server is pinned to **port 3001** so it coexists with the
> Developer Portal on 3000. Cognito authentication uses SRP (direct API
> calls to `cognito-idp.<region>.amazonaws.com`), not Hosted UI / OAuth
> redirect — there is no callback URL allow-list to update for localhost
> dev.

### Other commands

```bash
npm run build         # Production build to dist/
npm run preview       # Serve the production build locally
npm run lint          # ESLint
npm run typecheck     # TypeScript noEmit check
npm run format        # Prettier (write)
npm run format:check  # Prettier (check only — used by CI)
npm test              # Vitest run (CI mode)
npm run test:watch    # Vitest watch
npm run test:coverage # Vitest with v8 coverage report
```

## How to re-brand a fork

If you're forking this app for your own product, the re-brand surface is
deliberately concentrated:

1. **[`src/brand.ts`](src/brand.ts)** — product name, support email, brand
   colors, privacy/terms URLs. The MUI theme reads from here; nothing else
   should hardcode brand values.
2. **[`src/i18n/messages.en.json`](src/i18n/messages.en.json)** (+ the
   per-flow catalogs in [`src/i18n/hardening/`](src/i18n/hardening/)) — all
   user-facing copy. Re-word here, not in JSX.
3. **[`public/favicon.svg`](public/favicon.svg)** — drop in your icon.
4. **[`.env.example`](.env.example)** + your `.env.local` — point at your
   own Cognito pool.
5. **Hosting** — deploy `dist/` to your own static hosting (the reference
   deployment is S3 + CloudFront with the CSP/HSTS posture below set at the
   edge).

If you find yourself editing more than these, file an issue — that's a bug
in our separation of concerns.

## Security model

The posture below summarizes how the app handles tokens, scope, and CSP.

| Concern | Posture |
|---|---|
| **Cognito tokens at rest** | Stored by Amplify in browser `localStorage` (default). Mitigated by a strict CSP that blocks third-party scripts and inline scripts. Re-evaluate if your threat model includes browser-extension compromise — Amplify v6 supports `cookieStorage` as an alternative. |
| **Invite token verification** | The accept page verifies the invite token client-side against the API's JWKS endpoint (`GET /v1/auth/jwks`) before displaying the inviter org + invitee email — a JWKS outage shows an error, never unverified content. Cryptographic verification ALSO happens server-side in the platform's PostConfirmation Lambda via KMS; the client-side check is defense-in-depth for the display. |
| **Email field on accept page** | Pre-filled from the token's `email` claim and **locked** (read-only). This prevents a spectator who got the link from signing up under a different email — invariant from sub-user-invitations §11.2. |
| **CSP** | Set at the CloudFront edge (not in `<meta>` tags). Strict — no inline scripts (other than the boot bundle), no third-party origins beyond Cognito + the Vectros API host. |
| **HSTS** | Preload-ready (`max-age=63072000; includeSubDomains; preload`) on the production distribution. |
| **No PII in logs** | The global `unhandledrejection` / `error` listeners log to `console.error` only. They do **not** include the user's email, name, or any URL query parameters (which may contain invite tokens). |
| **Cognito auth flow** | SRP (Secure Remote Password) via Amplify v6's `signIn` / `signUp` calls directly against the Cognito User Pool API. No Hosted UI, no OAuth redirect, no callback-URL allow-list. The CSP `connect-src` whitelists `https://cognito-idp.<region>.amazonaws.com` so the SDK's API calls succeed. |

## Project layout

```
ui/admin-app/
├── public/              # Static assets served at /
│   └── favicon.svg
├── src/
│   ├── api/             # SDK client wiring (vectrosApi) + the Cognito-gated
│   │   │                # developer API for context enumeration (developerApi)
│   ├── auth/            # Thin re-export of @vectros-ai/react (single auth import surface)
│   ├── components/      # ApiErrorAlert, ScopeEditor, TenantSwitcher, MFA wizard, …
│   ├── i18n/            # IntlProvider wrapper + the English catalogs
│   ├── invitations/     # Invite-token JWKS verification + decode
│   ├── lib/             # queryClient, drainPages, scope helpers
│   ├── pages/
│   │   ├── protected/   # Welcome, Members, Keys, Logs, Usage, Contexts (+ role
│   │   │                # and access-profile editors), Account
│   │   └── public/      # LoginPage, AcceptPage, ConfirmPage, ForgotPasswordPage
│   ├── test/            # Vitest setup + provider helpers
│   ├── App.tsx          # Router (Routes only; BrowserRouter is in main.tsx)
│   ├── brand.ts         # SINGLE SOURCE OF TRUTH for branding
│   ├── config.ts        # Runtime config — fail-fast on missing env
│   ├── main.tsx         # ReactDOM mount + Amplify config + auth adapter wiring
│   └── theme.ts         # MUI theme (consumes brand.ts)
├── .env.example
├── eslint.config.js
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## Contributing back

This codebase is owned by Vectros. PRs against patterns documented here
(brand separation, security model, no inline strings) are welcome. PRs
that erode them are not — these patterns are why the codebase is useful as
a reference example.
