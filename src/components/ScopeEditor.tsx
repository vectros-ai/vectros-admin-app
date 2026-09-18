// ---------------------------------------------------------------------------
// ScopeEditor — controlled multi-clause permission builder.
//
// A token scope is a list of clauses; an action is permitted if ANY clause's
// `allowed_actions` covers it AND the clause's `data_scope` matches the row.
// The platform authorizer matches each `allowed_actions` entry as either:
//   - `*` (wildcard — grants every action), or
//   - the compact `resource:ops[:qualifier]` form, where each op is ONE letter
//     from a closed set the platform extends occasionally: c/r/u/d, plus `s`
//     for sensitive/PHI reveal and `x` for EXECUTE (running a stored script).
//     An entry WITHOUT a colon (e.g. a bare `read`) matches NOTHING — so a
//     resource MUST be named.
//
// Because a resource is mandatory, this editor is built around a
// resource × operations matrix: per clause you pick, for each resource, which
// of Create / Read / Update / Delete / Execute to grant — emitting
// `records:cru`, `documents:r`, `scripts:x`, etc. A "Full access" shortcut
// emits `*`. An Advanced escape hatch keeps the full grammar reachable (custom
// action verbs, per-type sensitive-reveal like `records:rs:patient`,
// qualifiers such as `scripts:x:<name>`) and round-trips any entry the matrix
// can't represent, so loading never drops data.
//
// v1 scope: `data_scope` (row-level ownership filters) stays `{}` — narrowing a
// clause to specific `scope:<ns>` rows is a later iteration. Apps needing
// it today can call the AccessProfile endpoint directly.
//
// Validation helpers are exported separately (no React dep) so callers in
// non-React contexts — mutation builders, tests — can validate the same shape.
// ---------------------------------------------------------------------------

import { memo, useEffect, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { FormattedMessage, useIntl } from 'react-intl';
import type { IntlShape } from 'react-intl';

import {
  DIMENSION_WILDCARD,
  parseDataScope,
  serializeDataScope,
  validateDataScope,
  canonicalDataScopeKey,
  countDataScopeNamespaces,
} from '../lib/dataScope';
import type { DataScopeDimension } from '../lib/dataScope';
import { MAX_SCOPE_NAMESPACES } from '../lib/scopeNamespace';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScopeClause {
  /**
   * Verb tokens the clause permits. The wildcard `*` grants every action;
   * other entries use the compact `resource:ops[:qualifier]` form (or a custom
   * action verb). A bare colon-less verb matches nothing at the authorizer.
   */
  readonly allowed_actions: readonly string[];

  /**
   * Row-level data filters (`scope:<ns>` allow-lists). The editor's v1 fixes
   * this to `{}` (no UI); the AccessProfile create endpoint accepts richer
   * shapes. Typed as `Record<string, unknown>` to leave room for the v2
   * key/value picker without a breaking shape change.
   */
  readonly data_scope: Record<string, unknown>;

  /**
   * Named platform capabilities this clause grants (0.40.0) — bounded effects
   * that reach across a partition boundary, which `allowed_actions` cannot
   * express (see {@link KNOWN_CAPABILITIES}). Absent/empty grants none. Kept
   * on the model (not dropped) even when empty, so a clause round-trips
   * byte-for-byte through load → save when untouched — a role or profile
   * carrying a capability grant must never lose it just because it was
   * opened in this editor.
   */
  readonly granted_capabilities?: readonly string[];

  /**
   * roleIds this clause may compose into a delegated access profile (0.43.0) —
   * a designated-role allow-list, orthogonal to `data_scope`/`allowed_actions`:
   * it narrows WHICH named roles this clause's authority may hand out, not how
   * much data it reaches. Authored via {@link AssignableRolesSection} below.
   *
   * **Absent means two opposite things, and conflating them is the trap.** At
   * ENFORCEMENT, absent is "no restriction" — the permissive default. At
   * AUTHORING it is the MAXIMAL value: a caller whose own covering clause
   * carries a restriction may not write a clause that omits one, because
   * claiming "unrestricted" is strictly wider than any list they could offer.
   * An EMPTY list is rejected outright on both paths, so the picker never emits
   * `[]` — an empty selection maps to `undefined` (omit the field), same as
   * {@link emptyClause}'s starting point.
   *
   * ⚠️ **The UI cannot tell whether the SIGNED-IN admin's own covering clause
   * is itself restricted** — that fact isn't part of the resolved-scope shape
   * `useScopeGate` exposes today, only the actions/identity it grants. So this
   * editor can't pre-fill the "right" list for a restricted admin, or warn
   * proactively that an empty selection will be refused for them specifically
   * — it can only make the inversion legible in copy (see
   * `scopeEditor.assignableRolesHelp`) and let the platform's own 403 surface
   * for the admin it actually affects. An unrestricted admin — the ordinary
   * shape — is never affected by any of this.
   *
   * The list is carried through untouched on every load → save that doesn't
   * touch it: dropping it would silently REMOVE a restriction a tenant
   * deliberately opted into, handing the delegate back the unrestricted
   * role-composing power the field exists to close. That is the same
   * round-trip contract `granted_capabilities` carries, in the more dangerous
   * direction — a silent WIDENING rather than a silent narrowing.
   */
  readonly assignable_roles?: readonly string[];
}

/**
 * roleId format the platform validates against: a lowercase letter first,
 * then lowercase letters/digits/hyphens, 3–31 characters total — the same
 * pattern a role's own id uses elsewhere in this app (see `RoleEditor.tsx`'s
 * own copy of this constant). Mirrored here rather than imported (the
 * platform's own copy of this regex is Java) so a freeSolo-typed entry can be
 * rejected client-side before a save round-trip does it server-side. Not
 * mechanically pinned to the platform's copy — a drift would surface as a
 * client-side rejection or acceptance disagreeing with the server's own,
 * which is a UX bug, not a security one (the server re-validates regardless).
 */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

/**
 * Structural cap on {@link ScopeClause.assignable_roles}'s size — mirrors the
 * platform's own limit on the same field. Validated client-side so a picker
 * that's grown past the limit is caught before save rather than at it.
 */
export const MAX_ASSIGNABLE_ROLES = 20;

/**
 * A role this editor can offer as an `assignable_roles` suggestion — the same
 * (roleId, name) pair {@link ScopeEditorProps.roleOptions} callers already have
 * on hand from their own roles-list query (e.g. `RoleResponse`). Deliberately
 * NOT the SDK's own response type: this keeps the picker decoupled from the SDK
 * shape, and a `RoleResponse[]` is structurally assignable here regardless.
 */
export interface AssignableRoleOption {
  readonly roleId: string;
  readonly name?: string;
}

/**
 * Structured validation error. Consumers can pattern-match on `code` to
 * render custom messaging, or pass to `formatScopeClauseValidationError`
 * for the catalog's default English copy via `react-intl`.
 */
export type ScopeClauseValidationError =
  | { readonly code: 'noClauses' }
  | { readonly code: 'noActions'; readonly clauseIndex: number }
  | {
      readonly code: 'blankAction';
      readonly clauseIndex: number;
      readonly actionIndex: number;
    }
  | {
      readonly code: 'dataScopeNamespace';
      readonly clauseIndex: number;
    }
  | {
      readonly code: 'dataScopeReserved';
      readonly clauseIndex: number;
      readonly namespace: string;
    }
  | {
      readonly code: 'dataScopeDuplicate';
      readonly clauseIndex: number;
      readonly namespace: string;
    }
  | { readonly code: 'dataScopeNoValues'; readonly clauseIndex: number }
  | {
      readonly code: 'dataScopeTooMany';
      readonly clauseIndex: number;
      readonly max: number;
    }
  | {
      readonly code: 'assignableRolesInvalid';
      readonly clauseIndex: number;
      readonly roleId: string;
    }
  | {
      readonly code: 'assignableRolesTooMany';
      readonly clauseIndex: number;
      readonly max: number;
    };

interface ScopeEditorProps {
  /** Current clause list. Caller owns the state. */
  readonly value: readonly ScopeClause[];
  /** Replaces the whole list (component is fully controlled). */
  readonly onChange: (next: ScopeClause[]) => void;
  /** Disables every editable control (no readonly props on existing rows). */
  readonly disabled?: boolean;
  /**
   * Roles to suggest in the `assignable_roles` picker — typically a context's
   * roles list a caller already has loaded for its own purposes (e.g.
   * `ProfileEditor`'s role-composition Autocomplete). Optional: the picker is a
   * freeSolo field regardless, so a caller with no roles list handy (e.g. the
   * scoped-key creation wizard, which has no context-roles query of its own)
   * still gets a fully working — just suggestion-free — picker.
   */
  readonly roleOptions?: readonly AssignableRoleOption[];
  /**
   * Namespace names to suggest in the data-scope namespace field — typically
   * the caller's own registry query (`lib/namespaceRegistry.ts`'s
   * tenant-wide ∪ context-own merge, ALL registered namespaces, not only
   * entity-backed ones). Optional and freeSolo regardless: a caller with no
   * registry query handy (or one still loading) still gets a working,
   * just suggestion-free, field — the platform accepts an unregistered
   * namespace as a legal free string, so this is never a gate,
   * only a suggestion list. `org`/`client` are ordinary entries in whatever
   * list the caller passes, never assumed here.
   */
  readonly namespaceOptions?: readonly string[];
  /**
   * Whether it's SAFE to mark a typed namespace "not registered" against
   * `namespaceOptions` — defaults to `false`. `namespaceOptions` reads
   * identically empty while the caller's registry query is still loading,
   * has failed, or has genuinely resolved to nothing registered; this
   * component has no visibility into which of those is true, so a caller
   * must say so explicitly once its OWN loading/error state has cleared
   * (mirrors `ProfileEditor`'s `canFlagUnregisteredNamespace`). Passing
   * `namespaceOptions` without this stays a pure, ungated suggestion list —
   * exactly as before this flag existed.
   */
  readonly canFlagUnregisteredNamespace?: boolean;
}

// ---------------------------------------------------------------------------
// Resource catalog
//
// `ops` lists the op letters meaningful for that resource (so the matrix only
// offers create/update/delete on resources that have them — search/inference/
// logs are read-only; whole-context delete is root-only so app-contexts omits
// `d`; scoped keys aren't updated so `keys` omits `u`; and `x` is listed ONLY
// on `scripts`, because the platform accepts the letter on every resource but
// gives it an effect on none of the others — `records:x` is a valid grant that
// grants nothing, so offering it would be a checkbox that does nothing).
// Over/under-listing is not a safety boundary — the authorizer is the
// authority and unmatched grants simply fail closed — and the Advanced field
// can express anything omitted.
// ---------------------------------------------------------------------------

export interface ResourceSpec {
  readonly value: string;
  readonly group: 'data' | 'management';
  readonly ops: string;
}

export const RESOURCE_CATALOG: readonly ResourceSpec[] = [
  { value: 'records', group: 'data', ops: 'crud' },
  { value: 'documents', group: 'data', ops: 'crud' },
  { value: 'folders', group: 'data', ops: 'crud' },
  { value: 'schemas', group: 'data', ops: 'crud' },
  // Scripts are immutable per version (no update surface); pushing a version is a
  // create, not an execution trigger — so no `u`. Execution is its OWN letter,
  // `x` (POST /v1/scripts/execute), and it is a separate Execute column rather
  // than a letter folded into the create/read/delete set: a grant to PUSH a
  // script version must never imply a grant to RUN one. The narrowed per-script
  // form `scripts:x:<name>` (one name, every version) is the only qualifier the
  // platform correlates on this resource; author it in Advanced, which
  // round-trips it untouched.
  { value: 'scripts', group: 'data', ops: 'crdx' },
  // Trigger rules FIRE: a matching record write dispatches the rule's script
  // under the grant the rule was provisioned with. Granting these verbs is
  // granting authority over live automation, not over an inert declaration.
  // Unlike scripts, a trigger rule is upsert-based (a blueprint re-apply
  // reconciles it in place), so it carries the full crud verb set.
  { value: 'triggers', group: 'data', ops: 'crud' },
  { value: 'search', group: 'data', ops: 'r' },
  { value: 'inference', group: 'data', ops: 'r' },
  { value: 'keys', group: 'management', ops: 'crd' },
  { value: 'profiles', group: 'management', ops: 'crud' },
  { value: 'app-contexts', group: 'management', ops: 'cru' },
  { value: 'logs', group: 'management', ops: 'r' },
  { value: 'users', group: 'management', ops: 'crud' },
  // `entities` (identity entities) replaces the retired `orgs`/`clients` grants;
  // `entities:<verb>:<ns>` narrows to a namespace, unqualified = all namespaces.
  // NOT `namespaces`: the backend delists it as a grantable resource (registry
  // reads are open, writes need a root key), so `namespaces:<verb>` is inert.
  { value: 'entities', group: 'management', ops: 'crud' },
];

/**
 * The matrix's operation columns, in canonical order — the four CRUD letters
 * plus `x` (Execute). The name is kept for forks that import it; the set is no
 * longer CRUD-only, because the platform's op alphabet is not. A column is
 * rendered per resource only where {@link ResourceSpec.ops} lists its letter,
 * so `x` shows as a checkbox on `scripts` and as `—` everywhere else.
 */
export const CRUD_OPS = [
  { letter: 'c', labelId: 'scopeEditor.opCreate' },
  { letter: 'r', labelId: 'scopeEditor.opRead' },
  { letter: 'u', labelId: 'scopeEditor.opUpdate' },
  { letter: 'd', labelId: 'scopeEditor.opDelete' },
  { letter: 'x', labelId: 'scopeEditor.opExecute' },
] as const;

/**
 * The `granted_capabilities` names THIS EDITOR offers to author — a subset of
 * the platform's full five-name closed list (see `ScopeClause.granted_capabilities`),
 * deliberately narrowed to the ones admin-app's own browser bearer can ever
 * back.
 *
 * The platform enforces a subset-of-caller rule on every scope-authoring
 * write: a clause may name a capability only if the calling credential's own
 * scope names it too. The browser session this app mints carries
 * `member-lifecycle` and `delegate-mint` — and that pairing is deliberate,
 * not an oversight to widen: cross-context and tenant-wide administrative
 * authority is served by dedicated server-side endpoints rather than by a
 * browser bearer, so no session of this app — OWNER or sub-user — can ever
 * back `forensic-read` or `context-directory-read`. Offering either as a
 * checkbox would ship a control that always fails, regardless of who
 * clicks it.
 *
 * `delegate-mint` is the second of the two, and it earned its spot for a
 * different reason: this app's browser session could already produce that
 * effect before capability-gating existed (minting a key bound to a
 * co-member required only the ordinary key-management permission), so it's
 * the architecturally-correct capability for this UI to offer. It is granted
 * to this session by default, the same way `member-lifecycle` is — not a
 * forward-looking placeholder.
 *
 * An unrecognized name denies the WHOLE clause server-side rather than being
 * ignored, so this editor never offers one outside this list — toggling only
 * ever adds/removes an exact known name, which is what keeps a name outside
 * THIS list (e.g. `forensic-read` on a role granted some other way, or
 * `delegate-principal-stamp` — real and grantable platform-side, just not yet
 * wired into this editor) untouched on save.
 */
export const KNOWN_CAPABILITIES = [
  { value: 'member-lifecycle', labelId: 'scopeEditor.capability.memberLifecycle' },
  { value: 'delegate-mint', labelId: 'scopeEditor.capability.delegateMint' },
] as const;

/**
 * Canonical letter order for a serialized ops segment. MUST contain every
 * letter any {@link RESOURCE_CATALOG} entry lists: {@link mergeOps} builds its
 * output by walking this string, so a letter missing here is silently DROPPED
 * on save rather than rejected — the matrix would render a ticked checkbox and
 * then write a grant without it.
 */
const CRUD_ORDER = 'crudx';
const CATALOG_BY_VALUE = new Map(RESOURCE_CATALOG.map((r) => [r.value, r]));

// ---------------------------------------------------------------------------
// Parse / serialize — the matrix display-model ⇄ wire `allowed_actions[]`.
// Exported for unit tests and non-React callers.
// ---------------------------------------------------------------------------

/** Display model for one clause's actions. */
export interface ClauseActionModel {
  /** `*` present → grants everything; the matrix + advanced are then moot. */
  readonly wildcard: boolean;
  /** resource value → granted ops string (subset of that resource's own
   * applicable letters, in {@link CRUD_ORDER} order). */
  readonly grants: Record<string, string>;
  /** Raw entries the matrix can't represent (custom verbs, qualified/`s` forms). */
  readonly advanced: readonly string[];
}

/** Union two ops strings into one, deduped and in canonical letter order. */
function mergeOps(a: string, b: string): string {
  let out = '';
  for (const letter of CRUD_ORDER) {
    if (a.includes(letter) || b.includes(letter)) out += letter;
  }
  return out;
}

/**
 * Parse a clause's `allowed_actions` into the matrix display model. An entry
 * is represented structurally ONLY if it's exactly `resource:ops` for a known
 * resource with ops ⊆ that resource's own applicable letters (no qualifier, no
 * `s`). So `scripts:x` parses into the matrix while `scripts:x:daily-report`
 * and `records:x` do not. Everything else — `*` (→ wildcard), bare verbs,
 * qualified/`s` forms, custom verbs, unknown resources — is preserved verbatim
 * (wildcard flag or `advanced`) so a round-trip never loses or silently
 * rewrites a grant.
 */
export function parseClauseActions(actions: readonly string[]): ClauseActionModel {
  let wildcard = false;
  const grants: Record<string, string> = {};
  const advanced: string[] = [];
  for (const raw of actions) {
    const a = (raw ?? '').trim();
    if (a === '') continue;
    if (a === '*') {
      wildcard = true;
      continue;
    }
    const segs = a.split(':');
    const [resource, ops] = segs;
    if (segs.length === 2 && resource && ops) {
      const spec = CATALOG_BY_VALUE.get(resource);
      if (spec && [...ops].every((c) => spec.ops.includes(c))) {
        grants[spec.value] = mergeOps(grants[spec.value] ?? '', ops);
        continue;
      }
    }
    advanced.push(a);
  }
  return { wildcard, grants, advanced };
}

/**
 * Serialize a matrix display model back to `allowed_actions`. Wildcard wins
 * (collapses to `['*']`). Otherwise: catalog-ordered `resource:ops` grants,
 * then the advanced entries — a deterministic order so an unedited round-trip
 * is stringify-stable.
 */
export function serializeClauseActions(model: ClauseActionModel): string[] {
  if (model.wildcard) return ['*'];
  const out: string[] = [];
  for (const spec of RESOURCE_CATALOG) {
    const ops = model.grants[spec.value];
    // Canonicalize ops to crud order so output is deterministic regardless of
    // the order letters were toggled / supplied in.
    if (ops) out.push(`${spec.value}:${mergeOps(ops, '')}`);
  }
  for (const raw of model.advanced) {
    const a = raw.trim();
    if (a) out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers — exported for non-React callers (mutation builders, tests)
// ---------------------------------------------------------------------------

/**
 * Build a fresh empty clause. `allowed_actions` is an empty list (the editor
 * validates non-emptiness at submit time); `data_scope` is `{}` (applies to
 * all rows within the tenant per the access-profile matching rule).
 */
export function emptyClause(): ScopeClause {
  // `assignable_roles` is deliberately ABSENT rather than `[]`: an empty list is
  // rejected outright by the platform (see ScopeClause.assignable_roles), and
  // the picker below never emits `[]` either — an empty selection maps back to
  // "field omitted", the same state this function starts from.
  //
  // Note what absent COSTS here, rather than reading it as the safe default. A
  // caller whose own covering clause is restricted cannot save a clause that
  // omits the field, so an unedited new clause from a restricted admin is still
  // refused at save until they explicitly pick at least one role in
  // AssignableRolesSection — no default this function could invent would be
  // correct, since the right list is the caller's own and this function isn't
  // told what that is (see the field's own javadoc for why the UI can't fill it
  // in automatically either).
  return { allowed_actions: [], data_scope: {}, granted_capabilities: [] };
}

/**
 * Project a clause list — editor state, or one read back from the API — into
 * the mutable wire shape the SDK's request types take.
 *
 * ONE place, deliberately. Every editor and dialog that SAVES clauses goes
 * through here, so a field the platform adds to a clause is carried by all of
 * them the moment it is added here. The failure mode this exists to prevent is
 * the one that produced it: `assignable_roles` shipped in 0.43.0 and six
 * hand-written clause mappings across three files each silently dropped it, so
 * opening a restricted role in this editor and pressing Save removed the
 * restriction — a silent WIDENING, invisible in the diff of any one file.
 */
export function toWireScopeClauses(
  clauses:
    | readonly {
        readonly allowed_actions?: readonly string[];
        readonly data_scope?: unknown;
        readonly granted_capabilities?: readonly string[] | undefined;
        readonly assignable_roles?: readonly string[] | undefined;
      }[]
    | null
    | undefined,
): {
  allowed_actions: string[];
  data_scope: Record<string, Record<string, unknown>>;
  granted_capabilities: string[];
  assignable_roles?: string[];
}[] {
  return (clauses ?? []).map((c) => ({
    allowed_actions: [...(c.allowed_actions ?? [])],
    data_scope: (c.data_scope ?? {}) as Record<string, Record<string, unknown>>,
    granted_capabilities: [...(c.granted_capabilities ?? [])],
    // Absent stays absent — see ScopeClause.assignable_roles. Emitting `[]`
    // here would turn every unrestricted clause into a 400 at save, and `[]` is
    // TRUTHY, so this tests `.length` rather than the value.
    ...(c.assignable_roles?.length ? { assignable_roles: [...c.assignable_roles] } : {}),
  }));
}

/**
 * Project a raw scope-clause list into the canonical editor form-state shape.
 * The SINGLE source of truth used to BOTH seed the editors' `scopes` state on
 * load AND derive their dirty-state baseline — keeping them in lockstep is what
 * fixes the "permanently dirty" bug. An empty/absent list becomes
 * `[emptyClause()]`; each clause's `allowed_actions` is copied into a fresh
 * array; `data_scope` is carried through (defaulted to `{}`).
 */
export function normalizeScopes(
  scopes:
    | readonly {
        readonly allowed_actions?: readonly string[];
        readonly data_scope?: unknown;
        readonly granted_capabilities?: readonly string[] | undefined;
        readonly assignable_roles?: readonly string[] | undefined;
      }[]
    | null
    | undefined,
): ScopeClause[] {
  if (!scopes || scopes.length === 0) {
    return [emptyClause()];
  }
  return scopes.map((s) => ({
    allowed_actions: [...(s.allowed_actions ?? [])],
    data_scope: (s.data_scope ?? {}) as Record<string, unknown>,
    // Carried through untouched — see ScopeClause.granted_capabilities. A
    // clause with none loaded gets [], matching emptyClause()'s default so
    // load/save comparisons (dirty-state) aren't fooled by undefined-vs-[].
    granted_capabilities: [...(s.granted_capabilities ?? [])],
    // Carried through untouched — see ScopeClause.assignable_roles. Note the
    // ASYMMETRY with the line above: an absent restriction must stay absent,
    // because on this field the platform reads [] as invalid, not as "none".
    // Defaulting it to [] the way capabilities are defaulted would turn every
    // unrestricted clause into a 400 at save. `.length`, not truthiness: an
    // empty array is truthy, so a bare `?` check would forward the one value
    // the platform rejects.
    ...(s.assignable_roles?.length ? { assignable_roles: [...s.assignable_roles] } : {}),
  }));
}

/**
 * Validate the supplied clause list. Returns null if every clause has at least
 * one non-blank string action, else a structured error identifying the first
 * problem found (matches backend `ScopeClause.validate` order).
 */
export function validateClauses(
  clauses: readonly ScopeClause[] | null | undefined,
): ScopeClauseValidationError | null {
  if (!clauses || clauses.length === 0) {
    return { code: 'noClauses' };
  }
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    if (!c?.allowed_actions || c.allowed_actions.length === 0) {
      return { code: 'noActions', clauseIndex: i };
    }
    for (let j = 0; j < c.allowed_actions.length; j++) {
      const a = c.allowed_actions[j];
      if (!a || typeof a !== 'string' || a.trim() === '') {
        return { code: 'blankAction', clauseIndex: i, actionIndex: j };
      }
    }
    // Row-level data-scope filters (namespaced ownership) — validate the same
    // shape the platform enforces, mapping to a clause-indexed error.
    const dsError = validateDataScope(
      parseDataScope(c.data_scope as Record<string, unknown> | undefined),
    );
    if (dsError) {
      switch (dsError.code) {
        case 'tooManyNamespaces':
          return { code: 'dataScopeTooMany', clauseIndex: i, max: dsError.max };
        case 'duplicate':
          return {
            code: 'dataScopeDuplicate',
            clauseIndex: i,
            namespace: dsError.namespace,
          };
        case 'noValues':
          return { code: 'dataScopeNoValues', clauseIndex: i };
        case 'namespace':
          if (dsError.error.code === 'reserved') {
            return {
              code: 'dataScopeReserved',
              clauseIndex: i,
              namespace: dsError.error.namespace,
            };
          }
          return { code: 'dataScopeNamespace', clauseIndex: i };
      }
    }
    // assignable_roles: format + count, mirroring the platform's own
    // validation order for this field (it runs last there too).
    // No duplicate check here, unlike allowed_actions/data_scope above:
    // AssignableRolesSection de-dupes on every change (see its own comment),
    // so nothing this editor can produce ever reaches this validator already
    // holding one — a duplicate can only arrive via a hand-built ScopeClause
    // (a test, a non-UI caller), which is exactly what
    // `assignableRolesInvalid`'s malformed-shape tests below exist to catch
    // via the format check instead of a separate duplicate one.
    if (c.assignable_roles && c.assignable_roles.length > 0) {
      if (c.assignable_roles.length > MAX_ASSIGNABLE_ROLES) {
        return { code: 'assignableRolesTooMany', clauseIndex: i, max: MAX_ASSIGNABLE_ROLES };
      }
      for (const rid of c.assignable_roles) {
        if (!rid || !ROLE_ID_PATTERN.test(rid)) {
          return { code: 'assignableRolesInvalid', clauseIndex: i, roleId: rid ?? '' };
        }
      }
    }
  }
  return null;
}

/**
 * Default formatter for {@link ScopeClauseValidationError} — produces a single
 * user-facing string via the message catalog. Forks can skip this and
 * pattern-match `error.code` themselves to produce custom copy.
 */
export function formatScopeClauseValidationError(
  error: ScopeClauseValidationError,
  intl: IntlShape,
): string {
  switch (error.code) {
    case 'noClauses':
      return intl.formatMessage({ id: 'scopeEditor.validationNoClauses' });
    case 'noActions':
      return intl.formatMessage(
        { id: 'scopeEditor.validationNoActions' },
        { n: error.clauseIndex + 1 },
      );
    case 'blankAction':
      return intl.formatMessage(
        { id: 'scopeEditor.validationBlankAction' },
        { clauseN: error.clauseIndex + 1, actionN: error.actionIndex + 1 },
      );
    case 'dataScopeNamespace':
      return intl.formatMessage(
        { id: 'scopeEditor.validationDataScopeNamespace' },
        { clauseN: error.clauseIndex + 1 },
      );
    case 'dataScopeReserved':
      return intl.formatMessage(
        { id: 'scopeEditor.validationDataScopeReserved' },
        { clauseN: error.clauseIndex + 1, namespace: error.namespace },
      );
    case 'dataScopeDuplicate':
      return intl.formatMessage(
        { id: 'scopeEditor.validationDataScopeDuplicate' },
        { clauseN: error.clauseIndex + 1, namespace: error.namespace },
      );
    case 'dataScopeNoValues':
      return intl.formatMessage(
        { id: 'scopeEditor.validationDataScopeNoValues' },
        { clauseN: error.clauseIndex + 1 },
      );
    case 'dataScopeTooMany':
      return intl.formatMessage(
        { id: 'scopeEditor.validationDataScopeTooMany' },
        { clauseN: error.clauseIndex + 1, max: error.max },
      );
    case 'assignableRolesInvalid':
      return intl.formatMessage(
        { id: 'scopeEditor.validationAssignableRolesInvalid' },
        { clauseN: error.clauseIndex + 1, roleId: error.roleId },
      );
    case 'assignableRolesTooMany':
      return intl.formatMessage(
        { id: 'scopeEditor.validationAssignableRolesTooMany' },
        { clauseN: error.clauseIndex + 1, max: error.max },
      );
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Memoized: every consumer passes a stable `onChange` (a useState setter) + the
// scopes array as `value`, so the 50-checkbox matrix doesn't re-render on every
// keystroke in a sibling field (role name/description) — only when the scope
// itself changes.
export const ScopeEditor = memo(function ScopeEditor({
  value,
  onChange,
  disabled = false,
  roleOptions,
  namespaceOptions,
  canFlagUnregisteredNamespace = false,
}: ScopeEditorProps): React.JSX.Element {
  const intl = useIntl();
  const clauses = value ?? [];

  const setClauseActions = (idx: number, actions: string[]): void => {
    onChange(clauses.map((c, i) => (i === idx ? { ...c, allowed_actions: actions } : c)));
  };

  const setClauseDataScope = (
    idx: number,
    dataScope: Record<string, unknown>,
  ): void => {
    onChange(clauses.map((c, i) => (i === idx ? { ...c, data_scope: dataScope } : c)));
  };

  const setClauseCapabilities = (idx: number, capabilities: readonly string[]): void => {
    onChange(
      clauses.map((c, i) => (i === idx ? { ...c, granted_capabilities: capabilities } : c)),
    );
  };

  // `undefined` (not `[]`) removes the restriction. Rebuilding the
  // clause explicitly, rather than `{ ...c, assignable_roles: roles }`, is what
  // keeps that possible: a spread can only ADD/overwrite a key, never omit one,
  // so an `undefined` value would otherwise be stored as the literal `undefined`
  // — which is not the same as the key being absent for a JSON-serializing save
  // call, and which `toWireScopeClauses`'s own `.length ?` truthiness check
  // exists specifically to not have to special-case.
  const setClauseAssignableRoles = (idx: number, roles: readonly string[] | undefined): void => {
    onChange(
      clauses.map((c, i) => {
        if (i !== idx) return c;
        const { allowed_actions, data_scope, granted_capabilities } = c;
        return {
          allowed_actions,
          data_scope,
          // `granted_capabilities` defaults to `[]` here the same way
          // CapabilitiesSection's own prop does — every clause this editor
          // produces already carries a real array (emptyClause/
          // normalizeScopes both default it), so this is just satisfying
          // `exactOptionalPropertyTypes` for the rebuilt object below, not a
          // behavior change.
          granted_capabilities: granted_capabilities ?? [],
          ...(roles !== undefined ? { assignable_roles: roles } : {}),
        };
      }),
    );
  };

  const addClause = (): void => {
    onChange([...clauses, emptyClause()]);
  };

  const removeClause = (idx: number): void => {
    onChange(clauses.filter((_, i) => i !== idx));
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Alert severity="info" icon={<InfoOutlinedIcon />}>
        <Typography variant="caption">
          <FormattedMessage id="scopeEditor.info" />
        </Typography>
      </Alert>

      {clauses.length === 0 && (
        <Paper
          variant="outlined"
          sx={{ p: 3, textAlign: 'center', color: 'text.secondary', borderStyle: 'dashed' }}
        >
          <Typography variant="body2">
            <FormattedMessage id="scopeEditor.empty" />
          </Typography>
        </Paper>
      )}

      {clauses.map((clause, idx) => (
        <ClauseCard
          key={idx}
          index={idx}
          clause={clause}
          disabled={disabled}
          showRemove={clauses.length > 1}
          roleOptions={roleOptions}
          namespaceOptions={namespaceOptions}
          canFlagUnregisteredNamespace={canFlagUnregisteredNamespace}
          onChangeActions={(actions) => setClauseActions(idx, actions)}
          onChangeDataScope={(ds) => setClauseDataScope(idx, ds)}
          onChangeCapabilities={(caps) => setClauseCapabilities(idx, caps)}
          onChangeAssignableRoles={(roles) => setClauseAssignableRoles(idx, roles)}
          onRemove={() => removeClause(idx)}
        />
      ))}

      <Box>
        <Tooltip title={intl.formatMessage({ id: 'scopeEditor.addClauseHelp' })}>
          <span>
            <Box
              component="button"
              type="button"
              onClick={addClause}
              disabled={disabled}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                px: 1,
                py: 0.5,
                border: 'none',
                background: 'none',
                color: disabled ? 'text.disabled' : 'primary.main',
                cursor: disabled ? 'default' : 'pointer',
                font: 'inherit',
                fontSize: 14,
              }}
            >
              <AddIcon fontSize="small" />
              <FormattedMessage id="scopeEditor.addClause" />
            </Box>
          </span>
        </Tooltip>
      </Box>
    </Box>
  );
});

// ---------------------------------------------------------------------------
// ClauseCard — one clause: full-access toggle + resource×CRUD matrix + advanced.
// ---------------------------------------------------------------------------

function ClauseCard({
  index,
  clause,
  disabled,
  showRemove,
  roleOptions,
  namespaceOptions,
  canFlagUnregisteredNamespace,
  onChangeActions,
  onChangeDataScope,
  onChangeCapabilities,
  onChangeAssignableRoles,
  onRemove,
}: {
  index: number;
  clause: ScopeClause;
  disabled: boolean;
  showRemove: boolean;
  roleOptions: readonly AssignableRoleOption[] | undefined;
  namespaceOptions: readonly string[] | undefined;
  canFlagUnregisteredNamespace: boolean;
  onChangeActions: (actions: string[]) => void;
  onChangeDataScope: (dataScope: Record<string, unknown>) => void;
  onChangeCapabilities: (capabilities: readonly string[]) => void;
  onChangeAssignableRoles: (roles: readonly string[] | undefined) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const intl = useIntl();
  const model = parseClauseActions(clause.allowed_actions);
  const matrixDisabled = disabled || model.wildcard;

  const resourceLabel = (resource: string): string =>
    intl.formatMessage({ id: `scopeEditor.resource.${resource}` });

  const setWildcard = (on: boolean): void => {
    onChangeActions(
      serializeClauseActions(
        on
          ? { wildcard: true, grants: {}, advanced: [] }
          : { wildcard: false, grants: model.grants, advanced: model.advanced },
      ),
    );
  };

  const toggleOp = (resource: string, letter: string): void => {
    const current = model.grants[resource] ?? '';
    const nextOps = current.includes(letter)
      ? [...current].filter((c) => c !== letter).join('')
      : mergeOps(current, letter);
    const grants = { ...model.grants };
    if (nextOps) grants[resource] = nextOps;
    else delete grants[resource];
    onChangeActions(serializeClauseActions({ wildcard: false, grants, advanced: model.advanced }));
  };

  const setAdvanced = (advanced: string[]): void => {
    onChangeActions(
      serializeClauseActions({ wildcard: false, grants: model.grants, advanced }),
    );
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
          <FormattedMessage id="scopeEditor.clauseLabel" values={{ n: index + 1 }} />
        </Typography>
        {showRemove && (
          <Tooltip title={intl.formatMessage({ id: 'scopeEditor.removeClause' })}>
            <span>
              <IconButton
                size="small"
                onClick={onRemove}
                disabled={disabled}
                aria-label={intl.formatMessage({ id: 'scopeEditor.removeClause' })}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Box>

      <FormControlLabel
        control={
          <Checkbox
            checked={model.wildcard}
            disabled={disabled}
            onChange={(e) => setWildcard(e.target.checked)}
          />
        }
        label={
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              <FormattedMessage id="scopeEditor.fullAccess" />
            </Typography>
            <Typography variant="caption" color="text.secondary">
              <FormattedMessage id="scopeEditor.fullAccessHelp" />
            </Typography>
          </Box>
        }
        sx={{ alignItems: 'flex-start', mb: 1 }}
      />

      {!model.wildcard && (
        <>
          <Table size="small" aria-label={intl.formatMessage({ id: 'scopeEditor.matrixLabel' })}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>
                  <FormattedMessage id="scopeEditor.colResource" />
                </TableCell>
                {CRUD_OPS.map((op) => (
                  <TableCell key={op.letter} align="center" sx={{ fontWeight: 600 }}>
                    <FormattedMessage id={op.labelId} />
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {(['data', 'management'] as const).map((group) => (
                <GroupRows
                  key={group}
                  group={group}
                  grants={model.grants}
                  disabled={matrixDisabled}
                  resourceLabel={resourceLabel}
                  onToggle={toggleOp}
                />
              ))}
            </TableBody>
          </Table>

          <Accordion
            disableGutters
            elevation={0}
            sx={{ mt: 1.5, '&:before': { display: 'none' }, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                <FormattedMessage id="scopeEditor.advancedTitle" />
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Autocomplete
                multiple
                freeSolo
                disabled={disabled}
                options={[]}
                value={[...model.advanced]}
                onChange={(_evt, v) => setAdvanced(v)}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={intl.formatMessage({ id: 'scopeEditor.advancedLabel' })}
                    placeholder={intl.formatMessage({ id: 'scopeEditor.advancedPlaceholder' })}
                    helperText={intl.formatMessage({ id: 'scopeEditor.advancedHint' })}
                    size="small"
                  />
                )}
              />
            </AccordionDetails>
          </Accordion>
        </>
      )}

      <DataScopeSection
        dataScope={clause.data_scope as Record<string, unknown> | undefined}
        disabled={disabled}
        namespaceOptions={namespaceOptions ?? []}
        canFlagUnregisteredNamespace={canFlagUnregisteredNamespace}
        onChange={onChangeDataScope}
      />

      <CapabilitiesSection
        capabilities={clause.granted_capabilities ?? []}
        disabled={disabled}
        onChange={onChangeCapabilities}
      />

      <AssignableRolesSection
        assignableRoles={clause.assignable_roles}
        roleOptions={roleOptions}
        disabled={disabled}
        onChange={onChangeAssignableRoles}
      />
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// CapabilitiesSection — per-clause `granted_capabilities` authoring. The list
// is closed (see KNOWN_CAPABILITIES): this section only ever toggles one of
// the four known names on or off, so any OTHER entry a loaded clause already
// carries (a future-release name this build doesn't know about) rides through
// untouched — toggling never rewrites the array wholesale.
// ---------------------------------------------------------------------------

const KNOWN_CAPABILITY_VALUES: readonly string[] = KNOWN_CAPABILITIES.map((c) => c.value);

/**
 * Canonical order for a capabilities array: known names in catalog order,
 * then anything this editor doesn't offer (an unrecognized/future name, or
 * one this editor deliberately excludes — see {@link KNOWN_CAPABILITIES}),
 * in their original relative order. Mirrors `serializeClauseActions`'s
 * catalog-then-advanced ordering for `allowed_actions`, for the same reason:
 * without it, an uncheck-then-recheck round-trip can reorder the array
 * (toggling always appends at the end) and read as a spurious edit against
 * `JSON.stringify`-based dirty-state comparisons even though nothing
 * actually changed.
 */
function canonicalizeCapabilities(capabilities: readonly string[]): string[] {
  const known = KNOWN_CAPABILITY_VALUES.filter((v) => capabilities.includes(v));
  const rest = capabilities.filter((v) => !KNOWN_CAPABILITY_VALUES.includes(v));
  return [...known, ...rest];
}

function CapabilitiesSection({
  capabilities,
  disabled,
  onChange,
}: {
  capabilities: readonly string[];
  disabled: boolean;
  onChange: (capabilities: readonly string[]) => void;
}): React.JSX.Element {
  const toggle = (name: string): void => {
    onChange(
      canonicalizeCapabilities(
        capabilities.includes(name)
          ? capabilities.filter((c) => c !== name)
          : [...capabilities, name],
      ),
    );
  };

  return (
    <Accordion
      disableGutters
      elevation={0}
      defaultExpanded={capabilities.length > 0}
      sx={{ mt: 1.5, '&:before': { display: 'none' }, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          <FormattedMessage id="scopeEditor.capabilitiesTitle" />
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1.5 }}>
          <FormattedMessage id="scopeEditor.capabilitiesHelp" />
        </Typography>
        <Stack spacing={0.5}>
          {KNOWN_CAPABILITIES.map((cap) => (
            <FormControlLabel
              key={cap.value}
              control={
                <Checkbox
                  size="small"
                  checked={capabilities.includes(cap.value)}
                  disabled={disabled}
                  onChange={() => toggle(cap.value)}
                />
              }
              label={
                <Typography variant="body2">
                  <FormattedMessage id={cap.labelId} />
                </Typography>
              }
            />
          ))}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// AssignableRolesSection — per-clause `assignable_roles` authoring (0.43.0).
// A freeSolo multi-value picker, same shape as the "Advanced" actions
// field above: `roleOptions` (when the caller has a roles list handy) makes
// existing roleIds discoverable, but typing an arbitrary roleId always works,
// since a clause can legitimately name a role this session can't itself list
// (e.g. one in a context the picker's own roles query isn't scoped to).
// ---------------------------------------------------------------------------

function AssignableRolesSection({
  assignableRoles,
  roleOptions,
  disabled,
  onChange,
}: {
  assignableRoles: readonly string[] | undefined;
  roleOptions: readonly AssignableRoleOption[] | undefined;
  disabled: boolean;
  onChange: (roles: readonly string[] | undefined) => void;
}): React.JSX.Element {
  const intl = useIntl();
  const current = assignableRoles ?? [];

  const roleNameById = new Map((roleOptions ?? []).map((r) => [r.roleId, r.name]));
  // Options exclude roleIds already picked — same "don't re-offer what's
  // already there" convention the Advanced actions field's freeSolo behavior
  // gives for free; here it's explicit because we're supplying a real options
  // list rather than leaving it empty.
  const suggestions = (roleOptions ?? [])
    .map((r) => r.roleId)
    .filter((id) => !current.includes(id));

  const setRoles = (next: readonly string[]): void => {
    // De-dupe defensively (freeSolo text entry can retype an id already
    // picked) while preserving first-seen order, so `validateClauses` never
    // has to reject an authored duplicate — the picker just never produces
    // one. An all-removed selection maps to `undefined` (field omitted), not
    // `[]` — see ScopeClause.assignable_roles: the platform rejects an
    // authored empty list outright.
    const deduped: string[] = [];
    for (const raw of next) {
      const rid = raw.trim();
      if (rid !== '' && !deduped.includes(rid)) deduped.push(rid);
    }
    onChange(deduped.length > 0 ? deduped : undefined);
  };

  return (
    <Accordion
      disableGutters
      elevation={0}
      defaultExpanded={current.length > 0}
      sx={{ mt: 1.5, '&:before': { display: 'none' }, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          <FormattedMessage id="scopeEditor.assignableRolesTitle" />
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1.5 }}>
          <FormattedMessage id="scopeEditor.assignableRolesHelp" />
        </Typography>
        <Autocomplete
          multiple
          freeSolo
          disabled={disabled}
          options={suggestions}
          value={[...current]}
          onChange={(_evt, v) => setRoles(v as string[])}
          getOptionLabel={(opt) => {
            const name = roleNameById.get(opt);
            return name ? `${name} (${opt})` : opt;
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label={intl.formatMessage({ id: 'scopeEditor.assignableRolesLabel' })}
              placeholder={
                current.length === 0
                  ? intl.formatMessage({ id: 'scopeEditor.assignableRolesPlaceholder' })
                  : undefined
              }
              size="small"
              inputProps={{
                ...params.inputProps,
                spellCheck: false,
              }}
            />
          )}
        />
      </AccordionDetails>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// DataScopeSection — per-clause row-level ownership filters (`data_scope`).
//
// Each dimension is a `scope:<namespace>` allow-list; the null opt-in ALSO
// matches rows with no value in that dimension. The section is collapsed by
// default (row-level filtering is the exception, not the norm) but expands
// automatically when the loaded clause already carries filters. `userId` and
// any other unmodellable key ride through `passthrough` verbatim.
//
// It owns local dimension state so an IN-PROGRESS row (blank namespace/value)
// survives — those serialize away, so a fully-controlled model couldn't hold
// them. State re-seeds only on an EXTERNAL change to the wire form (a profile
// load / reset), detected by comparing the canonical key against our own last
// emit; our own emits never trigger a resync (which would drop the blank row
// or steal focus).
// ---------------------------------------------------------------------------

/**
 * Autocomplete suggestions for a data-scope dimension's VALUES field — the
 * platform's placement matchers: the 0.38.0 `${{ any }}` / `${{ under.self.* }}`
 * forms plus the pre-existing `${{ self.* }}` forms. All are ordinary strings
 * in the wire `values[]` array — typing one verbatim already produces the
 * correct shape — this only makes them discoverable rather than something an
 * author has to already know to type.
 *
 * The namespace-scoped forms are offered for THIS row's own namespace AND for
 * `otherNamespaces` — the registered namespaces the caller suggests plus the
 * clause's other authored dimensions. This is not redundancy: the feature's own canonical
 * use case is cross-dimension (0.38.0's release note: *"a credential confined
 * to an organization can work with the clients under it"* — that's the
 * `client` DIMENSION matched by an `org`-scoped matcher). Suggesting only the
 * row's own namespace would never surface the form the feature exists for.
 * Neither namespace-scoped form is offered for the "*" wildcard dimension
 * (own or other), which names no single namespace to resolve against.
 */
function placementMatcherSuggestions(
  namespace: string,
  otherNamespaces: readonly string[],
): readonly string[] {
  const base = ['${{ any }}', '${{ self.userId }}', '${{ under.self.userId }}'];
  const candidates = new Set<string>();
  const own = namespace.trim();
  if (own && own !== DIMENSION_WILDCARD) candidates.add(own);
  for (const other of otherNamespaces) {
    const trimmed = other.trim();
    if (trimmed && trimmed !== DIMENSION_WILDCARD) candidates.add(trimmed);
  }
  for (const ns of candidates) {
    base.push(`\${{ self.scope.${ns} }}`, `\${{ under.self.scope.${ns} }}`);
  }
  return base;
}

function DataScopeSection({
  dataScope,
  disabled,
  namespaceOptions,
  canFlagUnregisteredNamespace,
  onChange,
}: {
  dataScope: Record<string, unknown> | undefined;
  disabled: boolean;
  namespaceOptions: readonly string[];
  canFlagUnregisteredNamespace: boolean;
  onChange: (dataScope: Record<string, unknown>) => void;
}): React.JSX.Element {
  const intl = useIntl();

  const [dims, setDims] = useState<DataScopeDimension[]>(
    () => parseDataScope(dataScope).dimensions as DataScopeDimension[],
  );
  const passthroughRef = useRef<Record<string, unknown>>(
    parseDataScope(dataScope).passthrough,
  );
  // Canonical key of the wire form our own state last produced.
  const selfKeyRef = useRef<string>(canonicalDataScopeKey(dataScope));

  // Resync from an external change (load/reset) — skip our own emits.
  useEffect(() => {
    const incomingKey = canonicalDataScopeKey(dataScope);
    if (incomingKey !== selfKeyRef.current) {
      const parsed = parseDataScope(dataScope);
      setDims(parsed.dimensions as DataScopeDimension[]);
      passthroughRef.current = parsed.passthrough;
      selfKeyRef.current = incomingKey;
    }
  }, [dataScope]);

  const commit = (next: DataScopeDimension[]): void => {
    setDims(next);
    const wire = serializeDataScope({
      dimensions: next,
      passthrough: passthroughRef.current,
    });
    selfKeyRef.current = canonicalDataScopeKey(wire);
    onChange(wire);
  };

  const addDimension = (): void => {
    commit([...dims, { namespace: '', values: [], includeNull: false }]);
  };
  const updateDimension = (
    index: number,
    patch: Partial<{ namespace: string; values: string[]; includeNull: boolean }>,
  ): void => {
    commit(dims.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };
  const removeDimension = (index: number): void => {
    commit(dims.filter((_, i) => i !== index));
  };

  const atLimit =
    countDataScopeNamespaces({ dimensions: dims, passthrough: passthroughRef.current }) >=
    MAX_SCOPE_NAMESPACES;

  return (
    <Accordion
      disableGutters
      elevation={0}
      defaultExpanded={dims.length > 0}
      sx={{ mt: 1.5, '&:before': { display: 'none' }, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          <FormattedMessage id="scopeEditor.dataScopeTitle" />
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1.5 }}>
          <FormattedMessage id="scopeEditor.dataScopeHelp" />
        </Typography>
        <Stack spacing={2}>
          {dims.map((dim, i) => {
            const trimmedNs = dim.namespace.trim();
            const namespaceNotRegistered =
              canFlagUnregisteredNamespace &&
              trimmedNs !== '' &&
              trimmedNs !== DIMENSION_WILDCARD &&
              !namespaceOptions.includes(trimmedNs);
            return (
            <Stack
              key={i}
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems="flex-start"
            >
              <Autocomplete
                freeSolo
                disabled={disabled}
                options={[...namespaceOptions, DIMENSION_WILDCARD]}
                value={dim.namespace}
                onInputChange={(_evt, v) => updateDimension(i, { namespace: v })}
                sx={{ width: { xs: '100%', sm: 200 } }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={intl.formatMessage({ id: 'scopeEditor.dataScopeNamespaceLabel' })}
                    placeholder={intl.formatMessage({
                      id: 'scopeEditor.dataScopeNamespacePlaceholder',
                    })}
                    helperText={
                      namespaceNotRegistered
                        ? intl.formatMessage({ id: 'scopeEditor.dataScopeNamespaceUnregistered' })
                        : undefined
                    }
                    size="small"
                    inputProps={{
                      ...params.inputProps,
                      spellCheck: false,
                      style: { fontFamily: 'monospace' },
                    }}
                  />
                )}
              />
              <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
                <Autocomplete
                  multiple
                  freeSolo
                  autoSelect
                  disabled={disabled}
                  options={placementMatcherSuggestions(dim.namespace, [
                    ...namespaceOptions,
                    ...dims.filter((_, j) => j !== i).map((d) => d.namespace),
                  ])}
                  value={[...dim.values]}
                  onChange={(_evt, v) => updateDimension(i, { values: v as string[] })}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label={intl.formatMessage({ id: 'scopeEditor.dataScopeValuesLabel' })}
                      placeholder={intl.formatMessage({
                        id: 'scopeEditor.dataScopeValuesPlaceholder',
                      })}
                      size="small"
                    />
                  )}
                />
                <FormControlLabel
                  sx={{ mt: 0.5 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={dim.includeNull}
                      disabled={disabled}
                      onChange={(e) => updateDimension(i, { includeNull: e.target.checked })}
                    />
                  }
                  label={
                    <Typography variant="caption" color="text.secondary">
                      <FormattedMessage id="scopeEditor.dataScopeIncludeNull" />
                    </Typography>
                  }
                />
              </Box>
              <Tooltip title={intl.formatMessage({ id: 'scopeEditor.dataScopeRemoveFilter' })}>
                <span>
                  <IconButton
                    size="small"
                    onClick={() => removeDimension(i)}
                    disabled={disabled}
                    aria-label={intl.formatMessage({ id: 'scopeEditor.dataScopeRemoveFilter' })}
                    sx={{ mt: 0.5 }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
            );
          })}
        </Stack>
        <Button
          size="small"
          variant="text"
          startIcon={<AddIcon />}
          onClick={addDimension}
          disabled={disabled || atLimit}
          sx={{ textTransform: 'none', mt: dims.length ? 1 : 0 }}
        >
          <FormattedMessage id="scopeEditor.dataScopeAddFilter" />
        </Button>
      </AccordionDetails>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// GroupRows — a labelled group (Data / Management) of resource rows.
// ---------------------------------------------------------------------------

function GroupRows({
  group,
  grants,
  disabled,
  resourceLabel,
  onToggle,
}: {
  group: 'data' | 'management';
  grants: Record<string, string>;
  disabled: boolean;
  resourceLabel: (resource: string) => string;
  onToggle: (resource: string, letter: string) => void;
}): React.JSX.Element {
  const intl = useIntl();
  const rows = RESOURCE_CATALOG.filter((r) => r.group === group);
  return (
    <>
      <TableRow>
        <TableCell
          colSpan={1 + CRUD_OPS.length}
          sx={{ py: 0.5, border: 0, color: 'text.secondary', fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}
        >
          <FormattedMessage id={`scopeEditor.group.${group}`} />
        </TableCell>
      </TableRow>
      {rows.map((spec) => {
        const ops = grants[spec.value] ?? '';
        const label = resourceLabel(spec.value);
        return (
          <TableRow key={spec.value} hover>
            <TableCell>{label}</TableCell>
            {CRUD_OPS.map((op) => {
              const applicable = spec.ops.includes(op.letter);
              return (
                <TableCell key={op.letter} align="center" sx={{ py: 0.25 }}>
                  {applicable ? (
                    <Checkbox
                      size="small"
                      checked={ops.includes(op.letter)}
                      disabled={disabled}
                      onChange={() => onToggle(spec.value, op.letter)}
                      inputProps={{
                        'aria-label': intl.formatMessage(
                          { id: 'scopeEditor.opCheckboxAria' },
                          { op: intl.formatMessage({ id: op.labelId }), resource: label },
                        ),
                      }}
                    />
                  ) : (
                    <Box component="span" sx={{ color: 'text.disabled' }} aria-hidden>
                      —
                    </Box>
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        );
      })}
    </>
  );
}
