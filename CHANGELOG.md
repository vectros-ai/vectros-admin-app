# Changelog

All notable changes to the Vectros Admin App are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

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
