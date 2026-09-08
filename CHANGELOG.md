# Changelog

All notable changes to the Vectros Admin App are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.21.0 — 2026-09-07

Adoption of the platform's 0.43.0 API surface.

### Added

- **The permission matrix now offers Execute, so you can grant "may run this stored script" without
  granting "may push script versions".** The platform's scope grammar gained an execute verb, `x`
  (`scripts:x`), separate from the create/read/delete verbs that govern script SOURCE. The matrix
  carries it as its own column rather than folding it into the script grants, because a permission
  to publish a script must never imply a permission to run one. The column shows a checkbox on
  Scripts alone: the platform accepts the letter on every resource but gives it an effect on no
  other, so offering it elsewhere would be a control that silently does nothing. The narrowed
  per-script form (`scripts:x:<name>` — one script name, every version of it) is not a checkbox;
  type it into Advanced, which round-trips it untouched.

- **Activity Logs can now filter on `issuers`.** The server accepts it and this app administers
  trusted issuers, so its absence from the dropdown was a gap rather than a policy.

- **The credit breakdown itemises script execution time.** The platform
  meters script execution and charges for the portion beyond what each execution's own billable
  operations included. That charge was already inside the headline "Credits used" figure while no
  category accounted for it. It now appears as its own "Script execution time" row. Note the
  category rows and the headline are each rounded down to whole credits independently, so the rows
  can still sum to slightly less than the headline; the API's `*Milli` fields carry the exact values
  for reconciliation.

### Fixed

- **Saving a role, access profile or scoped key no longer silently removes a role-composition
  restriction it did not author.** 0.43.0 added `assignable_roles` to a scope clause: an allow-list
  naming which roles that clause may compose into a delegated access profile, which exists to stop a
  delegate being handed unrestricted composing power one hop later. This app builds its save payload
  field by field, and every one of those payloads predated the field — so opening a restricted role
  or profile here and pressing Save wrote the clause back without it, quietly widening the grant.
  The restriction is now carried through every save path unchanged (including Clone, which had the
  same hole). An absent restriction stays absent, and is never written back as an empty list, which
  the platform rejects.

  ⚠️ **This app still cannot AUTHOR the list, and for one group of admins that is a hard block, not
  a missing convenience.** "Absent" means opposite things on the two paths: when a grant is
  ENFORCED it means "no restriction", but when a clause is AUTHORED it is the widest possible value
  — so an admin may not write a clause that omits a restriction when the permission of theirs that
  would authorise it carries one. (Holding a restriction somewhere is not enough to block you: the
  platform accepts a clause as soon as ANY one of your own permissions covers it, so an admin with
  both a restricted and an unrestricted route to the same authority is unaffected.)
  Because a new clause here always starts without the field, that admin cannot create a role,
  access profile, or scoped-key scope in this app at all; every save is refused. Editing an
  existing restricted clause still works, which is what makes the failure look arbitrary rather
  than like a rule. Admins whose own permissions carry no restriction — the ordinary case — are
  unaffected. Note this is not an exotic configuration: a blueprint can set the field when it
  provisions a role or an access profile, so an admin can land in it without anyone having reached
  for the API directly. Use the CLI or API to author these clauses.

- **Cloning an access profile no longer silently activates a suspended one.** A profile carries a
  status, and the clone dialog did not copy it — while creating a profile applies whatever status it
  is given and treats a missing one as active. So cloning a profile you had suspended handed you a
  live one. The clone now keeps its source's status. Note the consequence, because this app cannot
  undo it for you: a clone of a suspended profile arrives suspended, and nothing in this UI performs
  a status change, so activating it needs the CLI or API. That is deliberate — silently restoring
  access someone had deliberately withdrawn is the worse of the two outcomes.

- **Cloning a role or access profile no longer silently drops its assume entitlements.** A role can
  grant which identity values a holder may assume; that grant lives on the role itself rather than on
  its permission clauses, so the clone dialogs — which copy clause fields one by one — never carried
  it. The clone succeeded and was quietly a lesser role than the one it copied. It is now carried
  through, including when materialising a role into an inline profile, where the grant has to come
  down from the role because a role-referencing profile has none of its own. One consequence worth
  knowing: because the platform checks an assume grant against your own, a clone you could not have
  authored yourself is now refused outright instead of succeeding without the entitlement. A loud
  refusal is the intended behaviour here — the previous silence produced a role that looked right
  and was not.

- **Activity Logs no longer offers two filters that could only ever fail.** `clients` and `orgs`
  were retired onto `entities`; the server dropped them from the values it accepts rather than
  deprecating them, so picking either returned an error before the log query ran, and no historical
  log entry carries them to match in any case. Both are gone from the dropdown.

- **The credit breakdown's execution row is no longer labelled as trigger-only.** It read "Trigger
  script execution time", but the underlying figure covers trigger firings and synchronous script
  execution calls together — so an account that runs no triggers at all could see a charge on a row
  claiming otherwise. It now reads "Script execution time".

### Changed

- **Notes for anyone forking this app.** Three source-level surfaces moved, none of them
  behavioural on their own: `ScopeEditor` exports a new `toWireScopeClauses`, the single projection
  every save path now uses to turn clause state into a request body (add a field there, not at the
  call sites); `CRUD_OPS` gained a fifth entry for Execute, so a fork rendering that array directly
  gets a new column; and the exported `ScopeClause` type gained an optional `assignable_roles`.

- **The Advanced actions hint now describes the qualifier rules per resource.** It previously
  offered a single `resource:cruds[:type]` shape, which both omitted the execute letter and implied
  a qualifier is accepted anywhere. It is not: `records`/`entities` take one on any letters,
  `documents`/`users` on the reveal letter alone, `profiles` on create/update/delete alone, and
  `scripts` on execute alone, naming a script. An entry whose qualifier would not apply to every
  letter it grants is refused at save, so the old wording could lead an admin to author something
  the platform rejects.

- **`@vectros-ai/sdk` bumped to the 0.43.0 line** — for the
  `credits.breakdown.scriptExecution` and `execution` fields on the usage report, and the
  `assignable_roles` clause field above.

- **`@vectros-ai/react` bumped to 0.12.0** — `useScopeGate` now reads
  the mint response's server-resolved `identity`/`allowedActions` instead of decoding the token
  client-side. No production behavior change here (this app never read `identity.partnerUserId`
  directly); doc comments and test fixtures updated to the new `userId` identity-key spelling.

## 0.20.1 — 2026-08-30

### Fixed

- **Activity Logs page (`/logs`): a time-window rounding bug could permanently hide very recent
  entries.** The time-range presets (and the default "last 1h" window) built their end-of-window
  timestamp from the current instant, then truncated it to minute precision for the
  `datetime-local` picker — which could round the query's end boundary to a moment *before* traffic
  generated only seconds earlier, excluding it from the results. Because "Refresh" re-queries with
  the same already-applied window rather than recomputing it, a miss was permanent until a preset
  was picked again. The window's end is now rounded up to the next minute instead of down, so it
  never lands before the instant it was built.

## 0.20.0 — 2026-08-28

### Changed

- Bundled `@vectros-ai/sdk` refreshed to the current release's staging build.
- **`ApiErrorAlert`/`RequestIdCaption` and the API-error extraction helpers
  (`extractErrorMessage`/`extractRequestId`/`statusCodeOf`/`isVersionConflict`) now come from
  `@vectros-ai/react`**, not a local copy — these were byte-identical (comment-only diffs) across
  this app, `app-vectros-ai`, and `casework-spa`, so they've been promoted to the shared package
  (`@vectros-ai/react` 0.10.0). No behavior change; every call site now imports from
  `@vectros-ai/react`, and this app's own `error.requestId` message catalog entry was removed in
  favor of the package's base catalog entry.

## 0.19.0 — 2026-08-27

### Fixed

- **`MembersPage`/`InviteMemberDialog` no longer block inviting or resending while a TEST tenant is
  active.** Both carried a hard-coded live-tenant-only gate (button `disabled`, an explanatory info
  alert, and a resend-time guard) that assumed an invite always landed in the account's LIVE tenant
  regardless of which tenant was active. The backend now resolves whichever tenant the caller's own
  credential is bound to — live and test tenants are provisioned identically and are interchangeable
  through this UI — so the client-side gate was stale and blocking a legitimate flow. Removed, along
  with the copy describing the old mechanism.
- **`AcceptPage` no longer dead-ends when an invitee who already holds a Cognito identity (e.g. from a
  prior invite to another tenant) opens a second invite link while signed out.** The signup form's
  `signUp()` call 409s in that case (Cognito's `UsernameExistsException`) — previously this surfaced as
  a generic "something went wrong" inline error on a form that could now only ever fail again. The page
  now catches that specific failure and offers a "sign in instead" prompt, routing through `/login`
  with the accept link preserved so a successful sign-in lands back on this page and the existing
  auto-link flow (for an invitee already signed in as the invited email) takes over from there.

### Added

- **`LoginPage`'s post-sign-in redirect now preserves the query string of its target, not just the
  path.** The `AcceptPage` fix above depends on this: the accept link's invite token lives in the query
  string (`/accept?t=...`), and a path-only redirect would have landed back on a bare `/accept` with no
  token.
- **`ProfileEditor`'s role picker now authors a multi-role (`roleIds`) composition, not just displays
  one.** The single-role Autocomplete is now a multi-select: pick one role for the common case, or two
  or more to compose them additively (mirroring the CLI's repeatable `access grant --role` flag). A
  single selection saves as the deprecated `roleId` field for minimal wire diff / back-compat; two or
  more save as `roleIds`. Loading, editing, and removing roles from an existing composition are all
  supported now. Cloning a multi-role-composed profile stays unsupported (the Clone action stays
  disabled for that case, same as before this change).

### Changed

- **Scrubbed "partner" framing from code comments** (`api/developerApi.ts`, `api/vectrosApi.ts`,
  `main.tsx`, `pages/protected/{ContextsPage,ContextDetailPage,LogsPage,MembersPage}.tsx`).
  This is a public-mirrored reference app whose reader is a developer building on the Vectros
  API, never a "partner" — comment prose (`partner API` → `Vectros API`, `partner-API bearer` →
  `Vectros API bearer`, `Partner Dev Admins` → `Admins`, `partner forks`/`a real partner` →
  `forks`/`a real account`) now matches that customer-POV bar. Comment prose only — no real API
  symbols renamed (`setPartnerApiTokenMinter`, `partnerId`, `partnerUserId`, and backend
  identifiers like the `wirePartnerApiTokenMinter` import are unaffected).

## 0.18.0 — 2026-08-27

### Fixed

- **`ProfileEditor` no longer misreads a multi-role (`roleIds`) profile as an empty inline-scopes
  profile.** A profile's `roleId` is present only when exactly one role composes (0.41.0) — a
  profile composing 2+ roles (buildable today via the CLI/blueprints) returns `roleIds` only, and
  the editor's `if (loaded.roleId)` read branch fell through to "inline source" for that shape,
  showing the wrong (empty) scope list and risking silently dropping the composition on save. A
  loaded multi-role profile now renders as an explicit, read-only "composed of N roles" notice
  (role names resolved where possible) with Save disabled on that source — this editor doesn't
  author `roleIds` yet (tracked as a follow-up), so the fix is to stop misrepresenting it, not to
  build authoring under this fix. Switching to inline scopes (an explicit replacement, same as for
  a single-role profile) remains possible and is now correctly guarded by the discard-confirm
  dialog, which the same bug had also silently skipped for this shape (a bare `roleRef !== ''`
  check reads empty for a multi-role profile too).
- **The same `roleId`-only blind spot is fixed in three sibling read sites** that weren't caught
  by the fix above: `ProfileEditor`'s own Clone dialog (would have submitted an empty `scopes`
  array for a multi-role source, failing closed with an opaque `400` — Clone is now disabled for
  that shape, with an explanation); `RoleEditor`'s reference count (undercounted to 0 for a role
  referenced only via multi-role composition, so the delete-safety banner wrongly read "no
  profiles reference this role" — the delete itself was always independently refused
  server-side, but the UI must not say the opposite of what's true); and the Access Profiles list
  (`ContextDetailPage`), whose source-chip and `?roleId=` filter both had the same gap.
- **A full `grep -rn '\.roleId\b'` census closed out the same blind spot's remaining sites**
  (`MembersPage`'s Resend-invite gate — falsely reported "no role bound" and blocked Resend for a
  member who genuinely has roles, just not one this app can resend against yet; `MembersPage`'s
  access-profile column and `ScopedKeyCreateDialog`'s existing-profile summary, both of which
  silently omitted role info for a multi-role profile instead of showing it).
- **`InviteMemberDialog`'s "email already associated" 409 message no longer names the wrong
  cause.** The platform now grants/attaches access instead of 409ing when an email resolves to an
  ACTIVE or still-PENDING member of a *different* app context in the same tenant, so this
  structured 409 fires only for a member SUSPENDED in a different context — the
  message still said "pending or active membership... cancel that invitation first," which no
  longer describes any reachable case and told an admin hitting a real suspended-elsewhere
  collision to do the wrong thing (there's no invitation to cancel). Corrected to name the actual
  cause and point at reactivating the member in that other context instead.

### Added

- **Trusted Issuers page (`/access/issuers`).** View every third-party identity provider
  registered in the tenant and edit its safe fields (subject/email claim, active/suspended
  status, self-signup policies) through the owner-gated developer API. Registering a brand-new
  issuer still requires a provisioning-scoped credential no browser bearer holds, so this page is
  intentionally view + edit only — no create/delete affordance. The issuer's trust-anchor fields
  (issuer URL, JWKS endpoint, audience) and its app context are shown read-only for reference and
  can't be changed here.

### Changed

- **Repinned to `@vectros-ai/sdk` 0.41.0.** No API surface this app uses through the SDK client
  changed shape — the Trusted Issuers page above calls `/developer/issuers/{issuerId}` through this
  app's own hand-rolled `developerApi` fetch wrapper, not the generated SDK client, and the new
  `roleIds` access-profile field isn't adopted by `InviteMemberDialog` (still single `roleId`); see
  the [SDK changelog](https://github.com/vectros-ai/sdk/blob/main/CHANGELOG.md) for the full release.

## 0.17.0 — 2026-08-20

### Added

- **Transfer ownership, from the Members page.** A new per-row action on `MembersPage` lets an
  account owner hand off their OWNER role to another active member, calling the platform's
  `POST /developer/account-owner` route (which previously had no client anywhere in the product).
  Offered only to an OWNER session, and only for an eligible target (an ACTIVE, human member who
  isn't the caller) — the backend remains authoritative either way. Given how consequential the
  action is, confirming requires typing the target's own email exactly, and the dialog discloses,
  verbatim, the three things the API is deliberately blunt about: the transfer can't be undone by
  the caller (only the new owner can transfer it back), it re-points both the live and test
  tenants' owner slot in one call, and already-minted credentials are not revoked by it.

## 0.16.0 — 2026-08-19

### Changed

- **Repinned to `@vectros-ai/react` 0.8.0** — the multi-tenant developer-portal methods
  (`getMemberships`/`getActiveTenant`/`setActiveTenant`/etc.) moved out of the package's generic
  `useAuth()` surface into a `tenancyProvider` prop on `CurrentTenantProvider` (see that package's
  CHANGELOG for the full reasoning). `main.tsx` now passes the same Cognito adapter to both
  `<AuthProvider>` and `<CurrentTenantProvider tenancyProvider={...}>`; `AcceptPage`'s invite-linking
  now reads from `useCurrentTenant()` instead of `useAuth()`. No user-visible behavior change.
- **Repinned to SDK 0.40.0.** See the [SDK changelog](https://github.com/vectros-ai/sdk/blob/main/CHANGELOG.md)
  for the full release; the entries below cover what this app changed in response.
- **`DELETE /v1/users/{id}` now refuses to remove your account's last OWNER** (among other 409
  causes the endpoint already had). The Members page's Revoke confirmation now surfaces the
  server's actual reason beneath the generic error — the backend uses the same error class for the
  last-OWNER refusal and an unrelated cross-context-membership refusal, so the UI shows what the
  server actually said rather than assuming one specific cause from the status code alone.
- **Access-profile and role save failures now surface the server's specific reason** (`ProfileEditor`,
  `RoleEditor`) beneath the generic error title, when the server includes one — e.g. the new 400 for a
  `usr_` principal that doesn't exist yet, or a 403 naming a namespace/placement the credential may not
  write. The scoped-key creation wizard does the same for its mint-failure step, covering the new 403
  when minting a key bound to a different principal without the `delegate-mint` capability, and the
  now-uniform 404 that no longer distinguishes "user doesn't exist" from "no profile in this context".
  The invite-member dialog's generic-error message now prefers this same server-provided reason over
  the raw HTTP status text too.
- **The Usage page explains the two metrics that don't narrow for a context-confined credential.**
  `reads.calls.used`/`reads.dataOut.bytes` read `0` for such a credential because no per-context
  breakdown exists for those two — not because no calls were made — and `credits.remaining` may
  overstate what's actually available since the plan limit stays account-wide. A new note explains both
  when the signal (an unpopulated live/test environment) is present.
- **The role/access-profile scope editor now authors `granted_capabilities`** via a checkbox list
  per clause, offering the two capabilities of the platform's four named ones that an admin-app
  browser session can ever back — `member-lifecycle` and `delegate-mint`. The other two, `forensic-read`
  and `context-directory-read`, are cross-context/tenant-wide administrative capabilities no
  browser session can hold, so they're never offered as a checkbox here; a role granted either
  through another path is left untouched on save, same as any capability grant a loaded role or
  profile already carries (previously the field wasn't modeled at all, so saving would have
  silently dropped it).
- **The Advanced scope field's hint now shows the `profiles:c/u/d` principal-qualifier grammar**
  (`profiles:u:self`, `profiles:c:usr_<id>`) — already round-trip safe, now discoverable without
  reading the API reference.
- **The Logs page shows who delegated a credential**, for a request made under a delegate-minted
  `ssk_*` key.

### Fixed

- **The App Contexts detail page no longer reaches a partially-broken state for a session holding
  `app-contexts:r` but not `profiles:r`.** Its Roles/Profiles tabs need `profiles:r` (the same resource
  the nested Role/Profile editors already gate on); the route now requires both, matching the existing
  pattern rather than landing on a page whose tabs silently 403.
- **Scoped-key wizard: a freshly-created service principal now appears immediately in the
  Bind step's picker, pre-selected.** The Services tab's "Create service principal" flow
  previously invalidated + refetched the user list, but that list is backed by a
  membership-scoped query that only returns principals already holding an access profile in
  the current context — a principal fresh off create structurally never has one, so the row
  could never appear no matter how long you waited. The picker now writes the created
  principal straight into the cache instead of invalidating.

### Known limitations

- **Members, and any other page resolving a `usr_` principal to a name, can't see a user who
  has no access profile in the default context.** The server resolves this app's user list (and
  its principal-to-name lookups) by joining through that context's access profiles rather than
  scanning the tenant directly, so a user who exists but hasn't been granted a profile there is
  simply absent — no error, no indication anything is missing. Creating a service principal from
  the scoped-key wizard and immediately binding a key to it works around this for that one
  session (see the fix above); a pre-existing such user stays invisible on every other page,
  every refresh, until it's granted a profile in the default context.

## 0.15.0 — 2026-08-12

### Changed

- **Repinned to SDK 0.39.0.** No API surface this app uses changed shape; see the
  [SDK changelog](https://github.com/vectros-ai/sdk/blob/main/CHANGELOG.md) for the full release.

## 0.14.0 — 2026-08-05

### Changed

- **Repinned to SDK 0.38.0.** No API surface this app uses changed shape; see the
  [SDK changelog](https://github.com/vectros-ai/sdk/blob/main/CHANGELOG.md) for the full release.
- **The row-level scope filter editor (in Roles and Access Profile clauses) can now express the
  new "any other dimension" default.** Type `*` as the scope to state a rule for every ownership
  dimension a clause doesn't name explicitly, and the value field now suggests the matchers that
  make that useful — "any value present", or "values whose immediate parent is your own" — instead
  of requiring you to already know the syntax to type it.

### Fixed

- **Typing an invalid scope value in a profile's identity overrides now shows an inline error
  instead of a silent failed save.** Only a blank value was ever caught; a value containing a
  colon, space, or other punctuation looked accepted until you tried to save, then failed with no
  explanation.
- **Resend Invite is no longer offered to a member who doesn't hold the permission to use it.**
  It requires more than the permission to invite; a sub-user who could see the button but not use
  it got an unexplained failure on click. The button now explains why it's unavailable instead.
- **Revoke and Invite now follow the same rule as Resend.** Both were previously offered
  regardless of whether the signed-in credential actually had permission to use them; each now
  explains why it's unavailable when it isn't.
- **The identity overrides section of the access profile editor now explains why it can't be
  edited from an account with no identity of its own, instead of failing silently on save.**
  Granting an identity override requires already holding the value being granted; an account
  without one — the top-level owner credential, for example — always failed with no useful
  explanation. Its fields stay visible so existing values remain legible, but are disabled for
  that account, with an inline note explaining why. An account that does hold an identity can edit
  them as before.
- **Saving unrelated changes to an access profile that already has identity overrides no longer
  fails.** Every save previously resent the profile's existing overrides even when they weren't
  touched, so changing just a role or a scope on such a profile failed for a reason that had
  nothing to do with the change being made. Untouched overrides are no longer resent.
- **Cloning an access profile that has identity overrides your account doesn't hold no longer
  fails outright.** The clone now completes without them, with a note that they weren't carried
  over — previously the whole clone failed. Overrides your account does hold still copy across
  normally.
- **Deleting an access profile that has identity overrides your account doesn't hold is now
  blocked with an explanation instead of failing.** Removing such a profile always failed the same
  way a save or clone did; the delete button now says so up front rather than after the fact.

## 0.13.0 — 2026-08-04

### Fixed

- **Inviting a member, and the Members page's Access Profile column, no longer
  fail with a permission error.** Both targeted the reserved control-plane app
  context, while the bearer backing those requests is minted for the base
  `default` context. A credential may act only inside the context it is minted
  for, so every one of those calls was rejected: the role dropdown stayed
  empty, Resend Invite failed, the per-row Access Profile cell showed a load
  error, and submitting an invite failed outright — the whole add-a-member flow
  was unusable. Both surfaces now name `default`, which is where a member's
  access profile has to live for their own sign-in to resolve it. The Access
  Profile chip's link follows, so it now opens a page that exists.

- **Editing a role no longer proceeds when we cannot tell you what it will affect.** The role editor
  warns you how many access profiles reference a role, because saving propagates the change to every
  one of them. That warning is driven by a count, and when the profile list failed to load the count
  fell to zero — identical to "nothing references this role". The warning simply disappeared, and
  saving stayed enabled, so an edit could propagate with its blast radius silently understated. The
  editor now tells you the profiles could not be loaded and holds the save until they can be.

- **A long role, profile, member or context list no longer goes quietly short.** These lists are
  fetched a page at a time and joined together, and there is a ceiling on how many pages that will
  chase. On reaching it the list used to be handed back as though it were complete, so a picker could
  silently omit its tail — a role you hold would simply not be offered, and a member who exists would
  look removed. The surface now reports an error instead of showing a list it cannot vouch for. A
  list that ends exactly on the ceiling is still complete and still loads: confirming there is
  nothing further costs one more request, and that request is not counted against the ceiling.

- **Inviting a member is now offered only on your live tenant.** Invitations
  are always created in the live tenant whichever one you have selected, while
  the roles offered came from the selected one — so inviting from a test tenant
  picked a role that does not exist where the invitation lands. That was
  accepted rather than refused, and the member it created could then never sign
  in. The Invite button and Resend now explain this and stay unavailable until
  you switch, instead of silently sending the invitation somewhere else.

- **The paginator behind every list on these pages now refuses to return a
  partial answer.** It has a ceiling on how many pages it will fetch; on
  reaching it, it used to hand back whatever it had read so far, which is the
  silent truncation the paginator exists to prevent — a role picker missing its
  tail offers a choice that isn't there, and a members table missing its tail
  looks like someone was removed. It now reports an error naming both how many
  pages it fetched and how many rows it read, since "5000 rows over 50 pages"
  (a genuinely large listing) and "0 rows over 50 pages" (a cursor that never
  resolves) are different problems. Several screens were dropping that report
  on the floor — an unavailable app-context list left a filter silently empty,
  a failed count showed as a permanent "loading", and a failed role list looked
  like a context with no roles; each of those now says what happened. Nothing
  changes below 5000 entries in one app context.

  A second guard, which stopped paging when two consecutive cursors matched,
  has been removed: cursors are issued with a random element, so two of them
  never match and that check could never fire. It read as a protection this
  code did not have.

### Added

- A test helper (`src/test/contextBinding.ts`) that asserts a request naming an
  app context or tenant was made on a client built for that same one, and that
  the client was not built for a context no credential can be issued for. The
  previous tests stubbed the client factory in a way that ignored what it was
  asked for, so they passed against the broken flow above; forks writing their
  own context-scoped pages can reuse the helper to avoid the same blind spot.
  Its own limits are documented in the file, and it has its own tests.

## 0.12.0 — 2026-07-27

### Security

- Upgrade `react-router` to `^8.3.0`, clearing five published advisories that
  covered every 6.x/7.x release and 8.x up to 8.2.0. Three of the five are
  specific to server-side rendering and React Server Components, which this app
  does not use; the two that can reach a browser-only app are an open redirect
  via backslashes in link targets and inefficient route matching.

  Note that the upgrade does **not** by itself make a link target safe: an
  attacker-controlled value passed to `<Link to>` or `navigate()` can still
  resolve off-origin. Validate any redirect target you accept from a URL or
  from user input before routing to it — this app builds every navigation
  target from a literal path, so it has no such input today.

### Changed

- **Minimum React and Node versions are now higher**, following the router
  upgrade above. Forks need **React 19.2.7+** (this app pins 19.2.8) and
  **Node 22.22.0+**; `engines.node` was narrowed to `>=22.22.0` to match.

### Added

- Route-matching regression tests over the access section's route table: which
  route each URL resolves to — including the `/access` redirect, the nested
  role and profile routes, and the fall-through to the catch-all — and that a
  path parameter survives being encoded into a link and read back out,
  including ids containing `+`, `@`, `:`, `/`, `?`, `#` and `%`.

### Fixed

- **Signing in could leave the whole app unusable — nav showing only "Welcome",
  every other page blank.** The app minted its authorization token pinned to
  the reserved `vectros-admin` context, which the API no longer accepts as an
  explicit target for a token mint. Members, Scoped Keys, Activity Log, App
  Contexts, and Usage never needed that context in the first place — they now
  mint against the default context like everything else.
- **The reserved context's row in App Contexts could show a stuck loading
  spinner, and its Edit button always failed.** Its detail page now explains
  plainly that roles and access profiles aren't manageable there, instead of
  hanging or erroring.
- **Creating a scoped key no longer offers the reserved context as a target.**
  Picking it always failed to mint the key.

### Under the hood

- Updated to `@vectros-ai/sdk` 0.37.0.

## 0.11.0 — 2026-07-22

### Added

- **Activity log entries show the request reference id and, on failures, the
  error code.** Each row carries the `requestId` to quote when contacting
  support (the full id is shown on hover), and a call that was rejected with a
  typed reason shows that `errorCode` beneath its status.

### Security

- Pin `fast-xml-parser` to a non-vulnerable version (`^5.10.1`) via an override —
  above a published denial-of-service advisory in a transitive dependency.

## 0.10.0 — 2026-07-18

### Changed

- **Org and client are now built-in namespaces of the generic identity model,
  not a separate concept.** Identity overrides and data-scope filters on access
  profiles and roles are authored and shown through the same `scope:<namespace>`
  path as any custom scope. When granting scope to a profile or role, the
  **Identity entities** resource replaces the former separate Orgs and Clients
  resources.
- **Activity log** resource-type filters now include identity entities,
  namespaces, erasure requests, and export.

### Removed

- **The disclosures view drops the nested Client filter and column.** A
  read-access query is scoped by its subject (subject type + subject id); the
  platform no longer supports a secondary client narrower.

### Under the hood

- Updated to `@vectros-ai/sdk` 0.35.0, which retires the `/v1/orgs` and
  `/v1/clients` endpoints and the `orgId`/`clientId` wire fields in favor of the
  generic `/v1/entities` API and the `scopes` array.

## 0.9.0 — 2026-07-11

### Fixed

- **Identity overrides no longer disappear on save** — an access profile whose
  org or client override was stored in the newer namespaced form showed a blank
  override field in the editor and lost the override when the profile was saved.
  Overrides in every scope — org, client, and custom scopes — are now read,
  shown, and preserved through an edit.

### Added

- **Custom ownership scopes for access profiles and roles** — identity overrides
  now support custom scope namespaces (such as `group`) alongside org and
  client, up to two per profile. Scope clauses on roles and inline profiles can
  narrow a grant to specific owners with optional row-level data filters: an
  allow-list of values per scope, with a switch to also include items that carry
  no value in that scope. The profiles table lists each profile's override
  scopes instead of just a count.

## 0.8.1 — 2026-07-10

### Changed

- **Dependency maintenance** — updated `aws-amplify`, `vite`, `vitest`, and the
  Vectros SDK to their current releases and cleared known advisories in
  transitive dependencies. No functional changes.

## 0.8.0 — 2026-07-10

### Added

- **Accounting of disclosures** — a new Disclosures page lets an account owner
  look up who has read a given subject's protected data within an app context:
  when, which action (read, list, lookup, search, or RAG), against which record,
  and whether any sensitive value was actually revealed in plaintext. Results
  are paged. Because read-access logging is opt-in and off by default, the page
  is explicit that an empty result means "no recorded disclosures" — which is
  not the same as "no one accessed this subject" when logging is not enabled for
  the relevant context or record types.

## 0.7.1 — 2026-07-09

### Changed

- **Scoped API keys** now list only the keys for the selected Live/Test
  environment, matching the environment switcher at the top of the app. Switch
  environments to see the keys in the other one. Creating and revoking keys is
  unchanged.

## 0.7.0 — 2026-07-08

### Added

- **App-context teardown** — deleting an app context now performs a full,
  irreversible teardown of the context and everything in it (records, documents,
  folders, schemas, roles, and scoped keys), guarded by a typed-confirm dialog
  that requires re-typing the context id before it proceeds.
- **Update-available banner** — after a new version of the app is deployed, an
  already-open tab now shows a dismissible "a new version is available" prompt
  with a Refresh action, so a long-running session can move to the latest build
  instead of eventually hitting a stale-asset error. The refresh is always
  user-initiated.

### Changed

- **Scoped API keys** now list and revoke across **every** app context and both
  environments, not just the control-plane context.
- **Activity logs** are now shown across all of your app contexts by default,
  with an optional filter to narrow to a single context (replacing the previous
  one-context-at-a-time view).

### Fixed

- The **scoped-key creation wizard** can now create a key bound to any of your
  app contexts; previously it could only target the control-plane context.
- The creation wizard now runs the access-profile check and the key creation in
  the same environment, so changing the environment selector no longer leaves the
  profile and the key in different tenants.

## 0.6.0 — 2026-07-03

Initial open-source release (starting at 0.6.0 to reflect the internal iteration history) of the Vectros Admin App — the control-plane
reference application for the Vectros platform, and a forkable example of
building an admin surface on the Vectros API.

### Added

- Member management: invite, re-invite, and remove team members, with
  per-member access-profile visibility.
- Scoped API keys: list, create (a guided five-step wizard covering user,
  contexts, and roles), and revoke.
- App contexts: create, edit, and delete data contexts, with per-context
  roles and access profiles (including role cloning and reference-aware
  deletes).
- Activity logs: query API call history with time-range presets, resource,
  method, and key filters.
- Usage & credits: the account usage report — credits against your plan, a
  per-category breakdown, read metering, and live/test environment and
  per-context decompositions.
- Account security: TOTP multi-factor enrollment and management.
- Live/Test environment switcher, scope-gated navigation, and a
  single-file re-brand surface (`src/brand.ts`).
