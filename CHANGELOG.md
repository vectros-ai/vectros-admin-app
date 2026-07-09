# Changelog

All notable changes to the Vectros Admin App are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

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
