# Changelog

All notable changes to the Vectros Admin App are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

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
