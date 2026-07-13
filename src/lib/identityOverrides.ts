// ---------------------------------------------------------------------------
// identityOverrides — canonical read/write model for an access profile's
// per-context identity overrides.
//
// Under SDK 0.34 the platform reads ownership dimensions back CANONICALLY as
// `scope:<namespace>` keys — `scope:org`, `scope:client`, and open custom
// namespaces like `scope:group`. The legacy `orgId` / `clientId` keys are still
// accepted as write-time shorthand for `scope:org` / `scope:client`, but a
// stored/minted profile reads them back namespaced. Editing UI that assumed the
// flat `orgId` / `clientId` keys therefore saw `undefined` for a `scope:org`
// override — the override was invisible in the form and dropped on save.
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
} from './scopeNamespace';
import type { ScopeNamespaceError } from './scopeNamespace';

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
 * Parse a raw `identityOverrides` map into the editor form model. Accepts both
 * the canonical `scope:<ns>` keys and the legacy `orgId` / `clientId` shorthand;
 * `scope:org` / `scope:client` win over the legacy keys when (unusually) both
 * appear. Custom `scope:<ns>` dimensions land in `extras` in encounter order;
 * anything else is preserved verbatim in `passthrough`.
 */
export function parseIdentityOverrides(
  raw: Record<string, unknown> | null | undefined,
): IdentityOverridesModel {
  const src = raw ?? {};
  let org = '';
  let orgCanonical = false;
  let client = '';
  let clientCanonical = false;
  const extras: IdentityOverrideExtra[] = [];
  const passthrough: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    const str = stringifyOverrideValue(value);
    if (key === 'scope:org') {
      org = str;
      orgCanonical = true;
      continue;
    }
    if (key === 'orgId') {
      if (!orgCanonical) org = str;
      continue;
    }
    if (key === 'scope:client') {
      client = str;
      clientCanonical = true;
      continue;
    }
    if (key === 'clientId') {
      if (!clientCanonical) client = str;
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
 * dirty-comparison. Projects the map through parse→serialize (so the legacy and
 * canonical spellings of the same override compare equal) then stringifies with
 * sorted keys.
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
 * ≤2 cap.
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
  | { readonly code: 'extraMissingValue'; readonly index: number };

/**
 * Validate the authored overrides model. Returns null when savable. A row that
 * is entirely blank is ignored (it serializes away); a row with only one half
 * filled, a bad/reserved/built-in/duplicate namespace, or more than
 * {@link MAX_SCOPE_NAMESPACES} total dimensions is an error. Built-in
 * namespaces (org / client) must use their dedicated fields, so typing them in
 * an extra row is rejected as `extraBuiltin`.
 */
export function validateIdentityOverrides(
  model: IdentityOverridesModel,
): IdentityOverridesValidationError | null {
  const seen = new Set<string>();
  if (model.org.trim()) seen.add('org');
  if (model.client.trim()) seen.add('client');

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
    if (seen.has(ns)) return { code: 'extraDuplicate', index: i, namespace: ns };
    seen.add(ns);
  }

  if (countOverrideNamespaces(model) > MAX_SCOPE_NAMESPACES) {
    return { code: 'tooManyNamespaces', max: MAX_SCOPE_NAMESPACES };
  }
  return null;
}
