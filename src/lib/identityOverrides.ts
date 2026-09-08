// ---------------------------------------------------------------------------
// identityOverrides — canonical read/write model for an access profile's
// per-context identity overrides.
//
// The platform expresses ownership dimensions as canonical `scope:<namespace>`
// keys — `scope:org`, `scope:client`, and open custom namespaces like
// `scope:group`. `org` and `client` are built-in namespace values, authored and
// read back through the same `scope:<ns>` path as any other namespace — there is
// no dedicated `orgId` / `clientId` wire vocabulary.
//
// This module is the single source of truth for turning the wire map into the
// editor's form model and back, WITHOUT ever losing a dimension the UI doesn't
// render specially (custom namespaces round-trip through `extras`; anything the
// model can't place at all rides through `passthrough` verbatim). Pure, so the
// mutation builder, the dirty-check, and tests share one implementation.
// ---------------------------------------------------------------------------

import {
  MAX_SCOPE_NAMESPACES,
  SCOPE_BUILTIN_NAMESPACES,
  namespaceFromScopeKey,
  scopeKey,
  validateScopeNamespace,
  validateScopeValue,
} from './scopeNamespace';
import type { ScopeNamespaceError } from './scopeNamespace';

/**
 * Whether a SESSION (identified by its own resolved `identity` — see
 * `useScopeGate().identity` in `@vectros-ai/react`) holds any identity of its
 * own at all. This is a LIVE, per-session question, not a fixed fact about
 * the app: an owner session's credential carries no identity (nothing to
 * confer), but a sub-user session bound to an access profile with identity
 * overrides of its own generally does — and the platform's conferral rule
 * lets such a session grant EXACTLY the identity value it itself holds. A
 * session with none can never author a non-empty override; a session that
 * holds some MAY be able to (still bounded per-dimension by the backend —
 * see `sessionIdentityMatchesOverrides` for the precise, checkable form of
 * that bound; this function only answers "is authoring categorically
 * impossible for this session", the coarse question the editor's overall
 * shown-but-disabled state needs).
 *
 * `sessionIdentity` is the raw resolved identity (canonical `scope:<ns>` keys,
 * plus a non-namespace `userId` key this reuses `parseIdentityOverrides` to
 * filter out via `passthrough`).
 */
export function sessionHoldsAnyIdentity(
  sessionIdentity: Readonly<Record<string, string>>,
): boolean {
  return countOverrideNamespaces(parseIdentityOverrides(sessionIdentity)) > 0;
}

/**
 * Whether `sessionIdentity` holds, per key, EXACTLY the values in `raw` — the
 * platform's per-key equality rule (`Objects.equals(held, requested)`),
 * applied wholesale to a map instead of one key. This is the same test the
 * backend runs in two different roles, both of which reduce to identical
 * math:
 *   - **conferral** (creating/setting `raw` as new `identityOverrides`): may
 *     the caller grant exactly these values? — `raw` is the REQUESTED map.
 *   - **displacement** (clearing/deleting an EXISTING `identityOverrides`):
 *     does the caller hold every value it would be displacing? — `raw` is
 *     the PRIOR map, and the request is empty (nothing left to compare each
 *     key against, so a null/absent resulting value only agrees with a
 *     null/absent prior — any real prior value must be held to clear it).
 *
 * `null`/absent `raw` (no overrides at all) trivially passes — mirrors the
 * backend's own early-return-allow on an empty/absent map at both call sites.
 * Blank-valued entries are NOT filtered before comparing (unlike this
 * module's other helpers) — this deliberately mirrors the backend's raw,
 * canonicalization-free key/value equality, since the whole point is to
 * predict THAT check, not to reason about the value grammar.
 */
export function sessionIdentityMatchesOverrides(
  sessionIdentity: Readonly<Record<string, string>>,
  raw: Record<string, unknown> | null | undefined,
): boolean {
  if (raw == null) return true;
  return Object.entries(raw).every(([key, value]) => {
    const priorValue = value == null ? null : String(value);
    const held = Object.prototype.hasOwnProperty.call(sessionIdentity, key)
      ? sessionIdentity[key]
      : null;
    return held === priorValue;
  });
}

/** One authored custom-namespace override (a `scope:<namespace>` dimension). */
export interface IdentityOverrideExtra {
  readonly namespace: string;
  readonly value: string;
}

/**
 * The editor's form model for `identityOverrides`. `org` / `client` get
 * dedicated fields (the common case); every other `scope:<namespace>` dimension
 * is an `extras` row; any wire key the model can't represent at all is kept in
 * `passthrough` and re-emitted unchanged so a round-trip never drops data.
 */
export interface IdentityOverridesModel {
  readonly org: string;
  readonly client: string;
  readonly extras: readonly IdentityOverrideExtra[];
  readonly passthrough: Readonly<Record<string, unknown>>;
}

/** An empty (no-overrides) model. */
export function emptyIdentityOverrides(): IdentityOverridesModel {
  return { org: '', client: '', extras: [], passthrough: {} };
}

/** Coerce a wire value (string per the backend) to the editor's string form. */
function stringifyOverrideValue(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/**
 * Parse a raw `identityOverrides` map into the editor form model. Keys are the
 * canonical `scope:<ns>` form; `scope:org` / `scope:client` populate the
 * dedicated org / client fields and every other `scope:<ns>` dimension lands in
 * `extras` in encounter order. Anything else is preserved verbatim in
 * `passthrough`.
 */
export function parseIdentityOverrides(
  raw: Record<string, unknown> | null | undefined,
): IdentityOverridesModel {
  const src = raw ?? {};
  let org = '';
  let client = '';
  const extras: IdentityOverrideExtra[] = [];
  const passthrough: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    const str = stringifyOverrideValue(value);
    if (key === 'scope:org') {
      org = str;
      continue;
    }
    if (key === 'scope:client') {
      client = str;
      continue;
    }
    const ns = namespaceFromScopeKey(key);
    if (ns !== null) {
      extras.push({ namespace: ns, value: str });
      continue;
    }
    // Unmodellable key — preserve verbatim so save never drops it.
    passthrough[key] = value;
  }

  return { org, client, extras, passthrough };
}

/**
 * Serialize the editor form model back to a wire `identityOverrides` map in the
 * CANONICAL `scope:<ns>` form. Blank org/client/extra values are omitted; the
 * `passthrough` map is spread through unchanged. `org` / `client` emit
 * `scope:org` / `scope:client`; each non-blank extra emits `scope:<namespace>`.
 */
export function serializeIdentityOverrides(
  model: IdentityOverridesModel,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...model.passthrough };
  if (model.org.trim()) out[scopeKey('org')] = model.org.trim();
  if (model.client.trim()) out[scopeKey('client')] = model.client.trim();
  for (const extra of model.extras) {
    const ns = extra.namespace.trim();
    const v = extra.value.trim();
    if (ns && v) out[scopeKey(ns)] = v;
  }
  return out;
}

/**
 * A key-order-independent canonical string for a wire overrides map, for
 * dirty-comparison. Projects the map through parse→serialize (so a re-ordered or
 * differently-spread map of the same overrides compares equal) then stringifies
 * with sorted keys.
 */
export function canonicalOverridesKey(
  raw: Record<string, unknown> | null | undefined,
): string {
  return stableStringify(serializeIdentityOverrides(parseIdentityOverrides(raw)));
}

/** Canonical string for the current editor model (same normal form as above). */
export function canonicalOverridesKeyOfModel(
  model: IdentityOverridesModel,
): string {
  return stableStringify(serializeIdentityOverrides(model));
}

/**
 * What a save request's `identityOverrides` field should be, given the
 * CURRENT form model vs the BASELINE it was loaded from:
 *   - unchanged from baseline → `undefined` (omit the field entirely — PATCH
 *     semantics read an omitted field as "leave as-is"). This is what stops a
 *     save from resending an UNCHANGED, already-non-empty override, which
 *     would otherwise happen on every save of a profile that has one, for
 *     ANY edit at all (role, scopes, anything), not only an edit to the
 *     override itself.
 *   - changed AND still non-empty → the serialized wire form.
 *   - changed TO empty (cleared) → an explicit `{}`, NOT omitted — an
 *     omitted field means "leave as-is", so clearing a baseline's overrides
 *     requires actually sending the empty map, not dropping the key.
 *
 * `isCreate` treats any non-empty model as "changed" (there's no baseline to
 * diff against yet) and never needs the "clear" case (nothing existed to
 * clear).
 *
 * Pure and independent of any UI state, so it's testable on its own
 * regardless of whether the caller's form fields are enabled — see this
 * module's own test file for direct coverage of all three shapes above.
 */
export function identityOverridesRequestValue(
  currentModel: IdentityOverridesModel,
  baselineRaw: Record<string, unknown> | null | undefined,
  isCreate: boolean,
): Record<string, unknown> | undefined {
  const wire = serializeIdentityOverrides(currentModel);
  const hasOverrides = Object.keys(wire).length > 0;

  if (isCreate) {
    return hasOverrides ? wire : undefined;
  }

  const changed = canonicalOverridesKeyOfModel(currentModel) !== canonicalOverridesKey(baselineRaw);
  if (!changed) return undefined;
  return hasOverrides ? wire : {};
}

function stableStringify(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Count of scope namespaces the model declares (for the ≤2 limit). */
export function countOverrideNamespaces(model: IdentityOverridesModel): number {
  let n = 0;
  if (model.org.trim()) n += 1;
  if (model.client.trim()) n += 1;
  for (const extra of model.extras) {
    if (extra.namespace.trim() && extra.value.trim()) n += 1;
  }
  return n;
}

/** True when `namespace` is a built-in (has its own dedicated field). */
export function isBuiltinNamespace(namespace: string): boolean {
  return (SCOPE_BUILTIN_NAMESPACES as readonly string[]).includes(namespace.trim());
}

/**
 * Flatten a raw overrides map into `{ namespace, value }` display pairs — the
 * built-in org/client first, then custom namespaces, then any unmodellable
 * passthrough key (shown by its raw key). For read-only display (e.g. the
 * profiles table), so it surfaces the canonical namespaced VALUES, not a count.
 */
export function describeIdentityOverrides(
  raw: Record<string, unknown> | null | undefined,
): Array<{ namespace: string; value: string }> {
  const model = parseIdentityOverrides(raw);
  const out: Array<{ namespace: string; value: string }> = [];
  if (model.org.trim()) out.push({ namespace: 'org', value: model.org });
  if (model.client.trim()) out.push({ namespace: 'client', value: model.client });
  for (const extra of model.extras) {
    if (extra.namespace.trim()) {
      out.push({ namespace: extra.namespace, value: extra.value });
    }
  }
  for (const [key, value] of Object.entries(model.passthrough)) {
    out.push({ namespace: key, value: stringifyOverrideValue(value) });
  }
  return out;
}

/** True when an `extras` row has been started (either half filled in). */
function isActiveExtra(extra: IdentityOverrideExtra): boolean {
  return extra.namespace.trim() !== '' || extra.value.trim() !== '';
}

/**
 * Structured validation error for the overrides authoring UI. `extra*` errors
 * carry the offending `extras` row index; `tooManyNamespaces` is the whole-form
 * ≤2 cap. `orgInvalidValue` / `clientInvalidValue` / `extraInvalidValue` are the
 * scope-VALUE grammar the platform enforces — distinct from `extraMissingValue`,
 * which only catches blank.
 */
export type IdentityOverridesValidationError =
  | { readonly code: 'tooManyNamespaces'; readonly max: number }
  | {
      readonly code: 'extraNamespace';
      readonly index: number;
      readonly error: ScopeNamespaceError;
    }
  | { readonly code: 'extraBuiltin'; readonly index: number; readonly namespace: string }
  | { readonly code: 'extraDuplicate'; readonly index: number; readonly namespace: string }
  | { readonly code: 'extraMissingValue'; readonly index: number }
  | { readonly code: 'extraInvalidValue'; readonly index: number }
  | { readonly code: 'orgInvalidValue' }
  | { readonly code: 'clientInvalidValue' };

/**
 * Validate the authored overrides model. Returns null when savable. A row that
 * is entirely blank is ignored (it serializes away); a row with only one half
 * filled, a bad/reserved/built-in/duplicate namespace, a value that fails the
 * platform's scope-value grammar, or more than {@link MAX_SCOPE_NAMESPACES}
 * total dimensions is an error. Built-in namespaces (org / client) must use
 * their dedicated fields, so typing them in an extra row is rejected as
 * `extraBuiltin`.
 *
 * The value-grammar check runs on `org` / `client` / each `extras` value —
 * previously only blank was checked (`extraMissingValue`), and `org`/`client`
 * had no value check at all, so a value like `a:b` round-tripped to the server
 * and came back as a bare, uncaught 400.
 */
export function validateIdentityOverrides(
  model: IdentityOverridesModel,
): IdentityOverridesValidationError | null {
  const seen = new Set<string>();
  if (model.org.trim()) seen.add('org');
  if (model.client.trim()) seen.add('client');

  if (model.org.trim() && validateScopeValue(model.org.trim())) {
    return { code: 'orgInvalidValue' };
  }
  if (model.client.trim() && validateScopeValue(model.client.trim())) {
    return { code: 'clientInvalidValue' };
  }

  for (let i = 0; i < model.extras.length; i++) {
    const extra = model.extras[i];
    if (!extra || !isActiveExtra(extra)) continue;
    const ns = extra.namespace.trim();
    const nsError = validateScopeNamespace(ns);
    if (nsError) return { code: 'extraNamespace', index: i, error: nsError };
    if (isBuiltinNamespace(ns)) {
      return { code: 'extraBuiltin', index: i, namespace: ns };
    }
    if (extra.value.trim() === '') {
      return { code: 'extraMissingValue', index: i };
    }
    if (validateScopeValue(extra.value.trim())) {
      return { code: 'extraInvalidValue', index: i };
    }
    if (seen.has(ns)) return { code: 'extraDuplicate', index: i, namespace: ns };
    seen.add(ns);
  }

  if (countOverrideNamespaces(model) > MAX_SCOPE_NAMESPACES) {
    return { code: 'tooManyNamespaces', max: MAX_SCOPE_NAMESPACES };
  }
  return null;
}
