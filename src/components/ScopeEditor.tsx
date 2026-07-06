// ---------------------------------------------------------------------------
// ScopeEditor — controlled multi-clause permission builder.
//
// A token scope is a list of clauses; an action is permitted if ANY clause's
// `allowed_actions` covers it AND the clause's `data_scope` matches the row.
// The platform authorizer matches each `allowed_actions` entry as either:
//   - `*` (wildcard — grants every action), or
//   - the compact `resource:ops[:qualifier]` form, where ops are the letters
//     c/r/u/d (and `s` for sensitive/PHI reveal). An entry WITHOUT a colon
//     (e.g. a bare `read`) matches NOTHING — so a resource MUST be named.
//
// Because a resource is mandatory, this editor is built around a
// resource × operations matrix: per clause you pick, for each resource, which
// of Create / Read / Update / Delete to grant — emitting `records:cru`,
// `documents:r`, etc. A "Full access" shortcut emits `*`. An Advanced escape
// hatch keeps the full grammar reachable (custom action verbs, per-type
// sensitive-reveal like `records:rs:patient`, qualifiers) and round-trips any
// entry the matrix can't represent, so loading never drops data.
//
// v1 scope: `data_scope` (row-level ownership filters) stays `{}` — narrowing a
// clause to specific orgId/clientId rows is a later iteration. Apps needing
// it today can call the AccessProfile endpoint directly.
//
// Validation helpers are exported separately (no React dep) so callers in
// non-React contexts — mutation builders, tests — can validate the same shape.
// ---------------------------------------------------------------------------

import { memo } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
  Box,
  Checkbox,
  FormControlLabel,
  IconButton,
  Paper,
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
   * Row-level data filters (orgId / clientId / etc.). The editor's v1 fixes
   * this to `{}` (no UI); the AccessProfile create endpoint accepts richer
   * shapes. Typed as `Record<string, unknown>` to leave room for the v2
   * key/value picker without a breaking shape change.
   */
  readonly data_scope: Record<string, unknown>;
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
    };

interface ScopeEditorProps {
  /** Current clause list. Caller owns the state. */
  readonly value: readonly ScopeClause[];
  /** Replaces the whole list (component is fully controlled). */
  readonly onChange: (next: ScopeClause[]) => void;
  /** Disables every editable control (no readonly props on existing rows). */
  readonly disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Resource catalog
//
// `ops` lists the CRUD letters meaningful for that resource (so the matrix only
// offers create/update/delete on resources that have them — search/inference/
// logs are read-only; whole-context delete is root-only so app-contexts omits
// `d`; scoped keys aren't updated so `keys` omits `u`). Over/under-listing is
// not a safety boundary — the authorizer is the authority and unmatched grants
// simply fail closed — and the Advanced field can express anything omitted.
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
  { value: 'search', group: 'data', ops: 'r' },
  { value: 'inference', group: 'data', ops: 'r' },
  { value: 'keys', group: 'management', ops: 'crd' },
  { value: 'profiles', group: 'management', ops: 'crud' },
  { value: 'app-contexts', group: 'management', ops: 'cru' },
  { value: 'logs', group: 'management', ops: 'r' },
  { value: 'users', group: 'management', ops: 'crud' },
  { value: 'orgs', group: 'management', ops: 'crud' },
  { value: 'clients', group: 'management', ops: 'crud' },
];

/** CRUD operation columns, in canonical order. */
export const CRUD_OPS = [
  { letter: 'c', labelId: 'scopeEditor.opCreate' },
  { letter: 'r', labelId: 'scopeEditor.opRead' },
  { letter: 'u', labelId: 'scopeEditor.opUpdate' },
  { letter: 'd', labelId: 'scopeEditor.opDelete' },
] as const;

const CRUD_ORDER = 'crud';
const CATALOG_BY_VALUE = new Map(RESOURCE_CATALOG.map((r) => [r.value, r]));

// ---------------------------------------------------------------------------
// Parse / serialize — the matrix display-model ⇄ wire `allowed_actions[]`.
// Exported for unit tests and non-React callers.
// ---------------------------------------------------------------------------

/** Display model for one clause's actions. */
export interface ClauseActionModel {
  /** `*` present → grants everything; the matrix + advanced are then moot. */
  readonly wildcard: boolean;
  /** resource value → granted ops string (subset of `crud`, in crud order). */
  readonly grants: Record<string, string>;
  /** Raw entries the matrix can't represent (custom verbs, qualified/`s` forms). */
  readonly advanced: readonly string[];
}

/** Union two ops strings into one, deduped and in canonical crud order. */
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
 * resource with ops ⊆ that resource's applicable crud letters (no qualifier,
 * no `s`). Everything else — `*` (→ wildcard), bare verbs, qualified/`s` forms,
 * custom verbs, unknown resources — is preserved verbatim (wildcard flag or
 * `advanced`) so a round-trip never loses or silently rewrites a grant.
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
  return { allowed_actions: [], data_scope: {} };
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
}: ScopeEditorProps): React.JSX.Element {
  const intl = useIntl();
  const clauses = value ?? [];

  const setClauseActions = (idx: number, actions: string[]): void => {
    onChange(clauses.map((c, i) => (i === idx ? { ...c, allowed_actions: actions } : c)));
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
          onChangeActions={(actions) => setClauseActions(idx, actions)}
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
  onChangeActions,
  onRemove,
}: {
  index: number;
  clause: ScopeClause;
  disabled: boolean;
  showRemove: boolean;
  onChangeActions: (actions: string[]) => void;
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
    </Paper>
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
