// ---------------------------------------------------------------------------
// dataScope — read/write model for a scope clause's row-level `data_scope`.
//
// `data_scope` narrows the rows a clause applies to, keyed per ownership
// dimension: the `userId` (authoring principal) plus namespaced scopes
// `scope:<namespace>` (`scope:org`, `scope:client`, custom `scope:<ns>`).
// `orgId` / `clientId` are accepted as shorthand and read back namespaced. Each
// dimension's value is an allow-list; including `null` in that list ALSO grants
// rows that carry NO value in that dimension. An empty map applies to all rows;
// multiple dimensions AND together.
//
// The editor renders the namespaced scope dimensions; `userId` and anything the
// model can't represent (a non-array value, an unexpected key) ride through
// `passthrough` verbatim so a round-trip never drops a filter. Pure so the
// serializer, validator, and tests share one implementation.
// ---------------------------------------------------------------------------

import {
  MAX_SCOPE_NAMESPACES,
  namespaceFromScopeKey,
  scopeKey,
  validateScopeNamespace,
} from './scopeNamespace';
import type { ScopeNamespaceError } from './scopeNamespace';

/** One authored `scope:<namespace>` dimension of a data-scope filter. */
export interface DataScopeDimension {
  readonly namespace: string;
  /** The non-null allow-list values (as strings). */
  readonly values: readonly string[];
  /** True when `null` is in the allow-list (also match rows with no value here). */
  readonly includeNull: boolean;
}

/** The editor's form model for one clause's `data_scope`. */
export interface DataScopeModel {
  readonly dimensions: readonly DataScopeDimension[];
  /** `userId` + any wire key the model can't represent — re-emitted verbatim. */
  readonly passthrough: Readonly<Record<string, unknown>>;
}

/** An empty (match-all) data-scope model. */
export function emptyDataScope(): DataScopeModel {
  return { dimensions: [], passthrough: {} };
}

/** Bare namespace for a data-scope key, honoring the `orgId`/`clientId` sugar. */
function namespaceOfDataScopeKey(key: string): string | null {
  const ns = namespaceFromScopeKey(key);
  if (ns !== null) return ns;
  if (key === 'orgId') return 'org';
  if (key === 'clientId') return 'client';
  return null;
}

/**
 * Parse a raw `data_scope` map into the editor form model. A key that resolves
 * to a namespace AND whose value is an array becomes a dimension (null entries
 * fold into `includeNull`); everything else (notably `userId`, or a
 * non-array value) is preserved in `passthrough`.
 */
export function parseDataScope(
  raw: Record<string, unknown> | null | undefined,
): DataScopeModel {
  const src = raw ?? {};
  const dimensions: DataScopeDimension[] = [];
  const passthrough: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    const ns = namespaceOfDataScopeKey(key);
    if (ns !== null && Array.isArray(value)) {
      const values = value
        .filter((v) => v != null)
        .map((v) => (typeof v === 'string' ? v : String(v)));
      const includeNull = value.some((v) => v == null);
      dimensions.push({ namespace: ns, values, includeNull });
      continue;
    }
    passthrough[key] = value;
  }

  return { dimensions, passthrough };
}

/**
 * Serialize the form model back to a wire `data_scope` map in canonical
 * `scope:<ns>` form. A fully-blank dimension (no namespace) is dropped, but a
 * NAMED dimension with no values is emitted as an empty list on purpose: that
 * lets {@link validateDataScope} (run on the round-tripped wire form by the
 * editor's clause validator) catch it as `noValues` and block the save, rather
 * than silently vanishing and BROADENING the clause to every row. Duplicate
 * namespaces MERGE (union of values, OR of the null opt-in) so a second row for
 * the same scope never silently clobbers the first. `passthrough` is spread
 * through unchanged.
 */
export function serializeDataScope(
  model: DataScopeModel,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...model.passthrough };
  // Merge by namespace first so duplicate rows union rather than collide.
  const merged = new Map<string, { values: string[]; includeNull: boolean }>();
  const order: string[] = [];
  for (const dim of model.dimensions) {
    const ns = dim.namespace.trim();
    if (!ns) continue;
    const key = scopeKey(ns);
    const values = dim.values.map((v) => v.trim()).filter((v) => v !== '');
    const existing = merged.get(key);
    if (existing) {
      existing.values.push(...values);
      existing.includeNull = existing.includeNull || dim.includeNull;
    } else {
      merged.set(key, { values: [...values], includeNull: dim.includeNull });
      order.push(key);
    }
  }
  for (const key of order) {
    const { values, includeNull } = merged.get(key)!;
    const deduped = values.filter((v, i) => values.indexOf(v) === i);
    const list: Array<string | null> = [...deduped];
    if (includeNull) list.push(null);
    out[key] = list;
  }
  return out;
}

/** Key-order-independent canonical string of a wire data_scope, for compares. */
export function canonicalDataScopeKey(
  raw: Record<string, unknown> | null | undefined,
): string {
  return stableStringify(serializeDataScope(parseDataScope(raw)));
}

function stableStringify(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify(entries);
}

/** True when a dimension row has been started. */
function isActiveDimension(dim: DataScopeDimension): boolean {
  return (
    dim.namespace.trim() !== '' ||
    dim.values.some((v) => v.trim() !== '') ||
    dim.includeNull
  );
}

/** Count of scope namespaces the model declares (for the ≤2 limit). */
export function countDataScopeNamespaces(model: DataScopeModel): number {
  let n = 0;
  for (const dim of model.dimensions) {
    if (isActiveDimension(dim) && dim.namespace.trim() !== '') n += 1;
  }
  return n;
}

/** Structured validation error for the data-scope authoring UI. */
export type DataScopeValidationError =
  | { readonly code: 'tooManyNamespaces'; readonly max: number }
  | {
      readonly code: 'namespace';
      readonly index: number;
      readonly error: ScopeNamespaceError;
    }
  | { readonly code: 'duplicate'; readonly index: number; readonly namespace: string }
  | { readonly code: 'noValues'; readonly index: number };

/**
 * Validate the authored data-scope model. A fully-blank dimension is ignored; a
 * started dimension needs a valid namespace and at least one value (or the null
 * opt-in); namespaces must be unique; at most {@link MAX_SCOPE_NAMESPACES}
 * dimensions may be declared. Built-in namespaces (org / client) are valid here
 * — unlike identity overrides there are no dedicated fields to defer to.
 */
export function validateDataScope(
  model: DataScopeModel,
): DataScopeValidationError | null {
  const seen = new Set<string>();
  for (let i = 0; i < model.dimensions.length; i++) {
    const dim = model.dimensions[i];
    if (!dim || !isActiveDimension(dim)) continue;
    const ns = dim.namespace.trim();
    const nsError = validateScopeNamespace(ns);
    if (nsError) return { code: 'namespace', index: i, error: nsError };
    const hasValue =
      dim.values.some((v) => v.trim() !== '') || dim.includeNull;
    if (!hasValue) return { code: 'noValues', index: i };
    if (seen.has(ns)) return { code: 'duplicate', index: i, namespace: ns };
    seen.add(ns);
  }
  if (countDataScopeNamespaces(model) > MAX_SCOPE_NAMESPACES) {
    return { code: 'tooManyNamespaces', max: MAX_SCOPE_NAMESPACES };
  }
  return null;
}
