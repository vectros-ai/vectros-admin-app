// ---------------------------------------------------------------------------
// App — the route table.
//
// Structure:
//   - Public routes (no auth gate, no AppLayout) for login / signup-confirm /
//     accept-invite / forgot-password flows.
//   - A layout-route wrapping RequireAuth + AppLayout for authenticated
//     pages. The Outlet inside AppLayout renders the matched child route.
//   - A catch-all `*` redirects to `/`. With RequireAuth on `/`, unauth
//     users land back at `/login` via a single hop.
//
// BrowserRouter is provided by main.tsx (NOT here). This lets tests render
// <App /> inside a <MemoryRouter> with a controlled initial URL.
// ---------------------------------------------------------------------------

import { Navigate, Route, Routes } from 'react-router';

// Deep-import nav icons (not the barrel) — MUI v7's icons package trips jsdom
// EMFILE on Windows when the barrel is resolved, and deep imports tree-shake
// more reliably. (New icons here must also be pre-included in vite.config.ts'
// optimizeDeps.include — see the note there.)
import HomeIcon from '@mui/icons-material/Home';
import PeopleIcon from '@mui/icons-material/People';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import ArticleIcon from '@mui/icons-material/Article';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import BarChartIcon from '@mui/icons-material/BarChart';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';

import { AppLayout, RequireAuth, RequireScope } from '@vectros-ai/react';
import type { NavItemSpec } from '@vectros-ai/react';
import { BRAND } from './brand';
import { TenantSwitcher } from './components/TenantSwitcher';
import { AccountPage } from './pages/protected/AccountPage';
import { ContextDetailPage } from './pages/protected/ContextDetailPage';
import { ContextsPage } from './pages/protected/ContextsPage';
import { IssuersPage } from './pages/protected/IssuersPage';
import { AccessLogPage } from './pages/protected/AccessLogPage';
import { KeysPage } from './pages/protected/KeysPage';
import { LogsPage } from './pages/protected/LogsPage';
import { MembersPage } from './pages/protected/MembersPage';
import { ProfileEditor } from './pages/protected/ProfileEditor';
import { RoleEditor } from './pages/protected/RoleEditor';
import { UsagePage } from './pages/protected/UsagePage';
import { WelcomePage } from './pages/protected/WelcomePage';
import { AcceptPage } from './pages/public/AcceptPage';
import { ConfirmPage } from './pages/public/ConfirmPage';
import { ForgotPasswordPage } from './pages/public/ForgotPasswordPage';
import { LoginPage } from './pages/public/LoginPage';
import { NotFoundPage } from './pages/public/NotFoundPage';

// Single source of truth for the action each gated admin surface requires.
// Both the nav item's `gateAction` AND the route's `RequireScope` read from
// here, so a nav link and its route guard can never drift (a typo'd literal in
// one place but not the other is exactly the bug class this prevents).
//
// These are the real `resource:ops` grammar (see `RESOURCE_CATALOG` in
// components/ScopeEditor.tsx) — NOT the `admin:<resource>` spelling this
// table previously used. `admin:users`/`admin:keys`/`admin:logs`/
// `admin:profiles` are unauthorable: the platform's scope grammar rejects any
// op letter outside `cruds`, and none of those legacy strings' post-colon
// segments are — so no stored scope can ever carry them, and `RequireScope`/
// `ScopeGate` passed ONLY for a wildcard `*` credential. A sub-user's grant,
// however correctly scoped server-side, could never make the corresponding
// nav link or route visible. `useScopeGate().can()` is now ops-aware (unions
// across every unqualified `resource:ops` entry for the resource), so a
// plain `:r` read grant is sufficient here regardless of how the profile
// author split it across entries.
const ADMIN_ACTIONS = {
  members: 'users:r',
  keys: 'keys:r',
  logs: 'logs:r',
  // Accounting-of-disclosures gates on the SAME literal the backend enforces on
  // GET /v1/admin/access-log (`access-log:r`; an owner's wildcard covers it).
  accessLog: 'access-log:r',
  // The app-contexts lifecycle (list + detail) gates on the dedicated
  // `app-contexts` resource, not `profiles`.
  contexts: 'app-contexts:r',
  // The nested role-item and profile-item editors, by contrast, are on the
  // SAME backend resource as the item-level read/write ops the editors
  // themselves call (`profiles:r`/`profiles:u`/`profiles:d`) — the backend
  // has no separate `roles` resource; role and profile item routes are both
  // enforced on `profiles`. Read-only here (matching the read-only route
  // gates elsewhere in this table); Save/Clone/Delete on those editors don't
  // yet carry their own per-action gates (tracked as a follow-up, same shape
  // as MembersPage's action gates).
  profiles: 'profiles:r',
  // Usage gates on the SAME literal the backend enforces on GET /v1/usage
  // (`billing:r` on scoped tokens; an owner's wildcard covers it).
  usage: 'billing:r',
  // Trusted-issuer registry (view + edit safe fields). The dev-portal route
  // behind it is owner-gated server-side regardless of scope — mirrors
  // `contexts` above, which gates the same way for the same reason.
  issuers: 'issuers:r',
} as const;

// Admin App sidebar nav (labels are i18n message ids; gateAction is each
// surface's minimal read grant — see ADMIN_ACTIONS above — OWNER's wildcard
// covers them all, a sub-user without the grant stays hidden). The shared
// AppLayout renders these.
const ADMIN_NAV_ITEMS: ReadonlyArray<NavItemSpec> = [
  { to: '/', labelId: 'layout.navWelcome', gateAction: null, icon: <HomeIcon fontSize="small" /> },
  { to: '/members', labelId: 'layout.navMembers', gateAction: ADMIN_ACTIONS.members, icon: <PeopleIcon fontSize="small" /> },
  { to: '/keys', labelId: 'layout.navKeys', gateAction: ADMIN_ACTIONS.keys, icon: <VpnKeyIcon fontSize="small" /> },
  { to: '/logs', labelId: 'layout.navLogs', gateAction: ADMIN_ACTIONS.logs, icon: <ArticleIcon fontSize="small" /> },
  { to: '/disclosures', labelId: 'accessLog.nav', gateAction: ADMIN_ACTIONS.accessLog, icon: <VisibilityIcon fontSize="small" /> },
  { to: '/usage', labelId: 'layout.navUsage', gateAction: ADMIN_ACTIONS.usage, icon: <BarChartIcon fontSize="small" /> },
  { to: '/access/contexts', labelId: 'access.nav', gateAction: ADMIN_ACTIONS.contexts, icon: <AdminPanelSettingsIcon fontSize="small" /> },
  { to: '/access/issuers', labelId: 'access.issuers.nav', gateAction: ADMIN_ACTIONS.issuers, icon: <VerifiedUserIcon fontSize="small" /> },
];

export default function App(): React.JSX.Element {
  return (
    <Routes>
      {/* Public auth routes — no RequireAuth, no AppLayout chrome. */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept" element={<AcceptPage />} />
      <Route path="/confirm" element={<ConfirmPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />

      {/* Authenticated routes — gated by RequireAuth, wrapped in AppLayout. */}
      <Route
        element={
          <RequireAuth>
            <AppLayout
              brandName={BRAND.productName}
              brandLogoSrc={BRAND.logo}
              brandQualifier={BRAND.appQualifier}
              navItems={ADMIN_NAV_ITEMS}
              switcher={<TenantSwitcher />}
            />
          </RequireAuth>
        }
      >
        {/* Each gated route enforces the SAME action as its nav item's
            gateAction (above). Hiding the nav link is cosmetic — RequireScope
            stops a direct-URL visit by an under-scoped user from landing on a
            page whose API calls would 403. The backend remains authoritative. */}
        <Route index element={<WelcomePage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route
          path="/members"
          element={<RequireScope action={ADMIN_ACTIONS.members}><MembersPage /></RequireScope>}
        />
        <Route
          path="/keys"
          element={<RequireScope action={ADMIN_ACTIONS.keys}><KeysPage /></RequireScope>}
        />
        <Route
          path="/logs"
          element={<RequireScope action={ADMIN_ACTIONS.logs}><LogsPage /></RequireScope>}
        />
        <Route
          path="/disclosures"
          element={<RequireScope action={ADMIN_ACTIONS.accessLog}><AccessLogPage /></RequireScope>}
        />
        <Route
          path="/usage"
          element={<RequireScope action={ADMIN_ACTIONS.usage}><UsagePage /></RequireScope>}
        />
        {/* App Contexts + their Roles + Profiles. The /access root redirects to
            /access/contexts — the contexts list, which is always the landing
            surface (clicking a row opens its detail).
            The contexts LIST route gates on ADMIN_ACTIONS.contexts
            (`app-contexts:r`) alone; the nested role/profile ITEM editors gate
            on ADMIN_ACTIONS.profiles (`profiles:r`) instead — different
            backend resource, see that constant's comment.
            The context DETAIL route requires BOTH: ContextDetailPage's own
            list-roles/list-profiles calls need `profiles:r` in addition to
            the `app-contexts:r` its header needs, so a session holding only
            one of the two is redirected here rather than reaching a page
            whose tabs silently 403. RequireScope only checks ONE
            action, so the two gates nest instead of extending the component. */}
        <Route path="/access" element={<Navigate to="/access/contexts" replace />} />
        <Route
          path="/access/contexts"
          element={<RequireScope action={ADMIN_ACTIONS.contexts}><ContextsPage /></RequireScope>}
        />
        <Route
          path="/access/contexts/:ctxId"
          element={
            <RequireScope action={ADMIN_ACTIONS.contexts}>
              <RequireScope action={ADMIN_ACTIONS.profiles}>
                <ContextDetailPage />
              </RequireScope>
            </RequireScope>
          }
        />
        <Route
          path="/access/contexts/:ctxId/roles/:tplId"
          element={<RequireScope action={ADMIN_ACTIONS.profiles}><RoleEditor /></RequireScope>}
        />
        <Route
          path="/access/contexts/:ctxId/profiles/:principalId"
          element={<RequireScope action={ADMIN_ACTIONS.profiles}><ProfileEditor /></RequireScope>}
        />
        <Route
          path="/access/issuers"
          element={<RequireScope action={ADMIN_ACTIONS.issuers}><IssuersPage /></RequireScope>}
        />
      </Route>

      {/* Unknown route → dedicated 404. Chrome-less; its
          "back home" link funnels through RequireAuth for unauth users. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
