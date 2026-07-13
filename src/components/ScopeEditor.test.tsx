// ---------------------------------------------------------------------------
// ScopeEditor tests — mirrors the dev-portal ScopeEditor.test.js coverage
// profile + adds tests for the structured-error / formatter contract that
// the TypeScript port introduces.
//
// Tests pin:
//   1. emptyClause() returns the canonical shape + a fresh instance each call.
//   2. validateClauses() rejects null / undefined / empty / no-actions /
//      blank-action / non-string-action and accepts valid lists.
//   3. formatScopeClauseValidationError() formats every discriminant.
//   4. <ScopeEditor> renders empty state, numbered clause headers, and the
//      Add / Remove controls correctly wire to onChange.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createIntl, createIntlCache } from 'react-intl';

import { TestIntlProvider } from '../test/intl';
import { I18N_DEFAULT_LOCALE } from '../i18n/IntlProvider';
import enMessages from '../i18n/messages.en.json';
import {
  ScopeEditor,
  emptyClause,
  formatScopeClauseValidationError,
  normalizeScopes,
  parseClauseActions,
  serializeClauseActions,
  validateClauses,
} from './ScopeEditor';
import type { ScopeClause } from './ScopeEditor';

// ---------------------------------------------------------------------------
// emptyClause()
// ---------------------------------------------------------------------------

describe('emptyClause()', () => {
  it('returns a fresh empty clause shape', () => {
    expect(emptyClause()).toEqual({ allowed_actions: [], data_scope: {} });
  });

  it('returns a fresh instance each call (no shared references)', () => {
    const a = emptyClause();
    const b = emptyClause();
    expect(a).not.toBe(b);
    expect(a.allowed_actions).not.toBe(b.allowed_actions);
    expect(a.data_scope).not.toBe(b.data_scope);
  });
});

// ---------------------------------------------------------------------------
// normalizeScopes() — the dirty-state baseline projector
// ---------------------------------------------------------------------------

describe('normalizeScopes()', () => {
  it('maps null / undefined / empty to a single blank clause (matches the seed)', () => {
    const blank = [emptyClause()];
    expect(normalizeScopes(null)).toEqual(blank);
    expect(normalizeScopes(undefined)).toEqual(blank);
    expect(normalizeScopes([])).toEqual(blank);
  });

  it('carries data_scope through (the dropped key that caused the bug)', () => {
    const scope = { allowed_actions: ['read'], data_scope: { orgId: 'org_1' } };
    expect(normalizeScopes([scope])).toEqual([
      { allowed_actions: ['read'], data_scope: { orgId: 'org_1' } },
    ]);
  });

  it('defaults missing allowed_actions / data_scope per clause', () => {
    expect(normalizeScopes([{ allowed_actions: ['read'] }])).toEqual([
      { allowed_actions: ['read'], data_scope: {} },
    ]);
    expect(normalizeScopes([{ data_scope: { a: 1 } }])).toEqual([
      { allowed_actions: [], data_scope: { a: 1 } },
    ]);
  });

  it('copies into fresh inner arrays (no aliasing of the source)', () => {
    const src = [{ allowed_actions: ['read'], data_scope: {} }];
    const out = normalizeScopes(src);
    expect(out[0]?.allowed_actions).not.toBe(src[0]?.allowed_actions);
    expect(out[0]?.allowed_actions).toEqual(['read']);
  });

  it('round-trips so a re-normalized clause list is stringify-stable (clean-on-load)', () => {
    // The editors seed `scopes` via normalizeScopes AND compare against
    // normalizeScopes(baseline) — so a pristine load must compare equal.
    const loaded = [{ allowed_actions: ['records:r', 'documents:r'], data_scope: {} }];
    const seeded = normalizeScopes(loaded);
    expect(JSON.stringify(seeded)).toBe(JSON.stringify(normalizeScopes(loaded)));
  });
});

// ---------------------------------------------------------------------------
// validateClauses() — returns ScopeClauseValidationError | null
// ---------------------------------------------------------------------------

describe('validateClauses()', () => {
  it('rejects null', () => {
    expect(validateClauses(null)).toEqual({ code: 'noClauses' });
  });

  it('rejects undefined', () => {
    expect(validateClauses(undefined)).toEqual({ code: 'noClauses' });
  });

  it('rejects empty array', () => {
    expect(validateClauses([])).toEqual({ code: 'noClauses' });
  });

  it('rejects a clause with no allowed actions, citing the clause index', () => {
    expect(validateClauses([{ allowed_actions: [], data_scope: {} }])).toEqual({
      code: 'noActions',
      clauseIndex: 0,
    });
  });

  it('rejects the second clause when only the first is valid, citing index 1', () => {
    expect(
      validateClauses([
        { allowed_actions: ['read'], data_scope: {} },
        { allowed_actions: [], data_scope: {} },
      ]),
    ).toEqual({ code: 'noActions', clauseIndex: 1 });
  });

  it('rejects a blank-string action with its index', () => {
    expect(
      validateClauses([{ allowed_actions: ['read', '   '], data_scope: {} }]),
    ).toEqual({ code: 'blankAction', clauseIndex: 0, actionIndex: 1 });
  });

  it('rejects an empty-string action', () => {
    expect(
      validateClauses([{ allowed_actions: [''], data_scope: {} }]),
    ).toEqual({ code: 'blankAction', clauseIndex: 0, actionIndex: 0 });
  });

  it('rejects a non-string action at runtime (JSON-parsed shapes)', () => {
    // TS prevents this at compile time, but raw JSON might carry it; the
    // runtime defense is still useful for partner-fork code paths that
    // skip the type system (e.g. data coming from a CSV import).
    const clauses = [
      { allowed_actions: ['read', 42 as unknown as string], data_scope: {} },
    ];
    expect(validateClauses(clauses)).toEqual({
      code: 'blankAction',
      clauseIndex: 0,
      actionIndex: 1,
    });
  });

  it('accepts a single valid clause', () => {
    expect(
      validateClauses([{ allowed_actions: ['read'], data_scope: {} }]),
    ).toBeNull();
  });

  it('accepts the wildcard "*" action', () => {
    expect(
      validateClauses([{ allowed_actions: ['*'], data_scope: {} }]),
    ).toBeNull();
  });

  it('accepts multiple clauses with multiple actions each', () => {
    expect(
      validateClauses([
        { allowed_actions: ['read', 'write'], data_scope: {} },
        { allowed_actions: ['admin:keys'], data_scope: {} },
      ]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatScopeClauseValidationError() — default English copy via react-intl
// ---------------------------------------------------------------------------

describe('formatScopeClauseValidationError()', () => {
  // Use a bare intl instance — no need for the full Provider tree since
  // this helper just calls intl.formatMessage on a known catalog.
  const intl = createIntl(
    { locale: I18N_DEFAULT_LOCALE, messages: enMessages as Record<string, string> },
    createIntlCache(),
  );

  it('formats noClauses', () => {
    expect(formatScopeClauseValidationError({ code: 'noClauses' }, intl)).toBe(
      'At least one scope clause is required',
    );
  });

  it('formats noActions with 1-based clause index', () => {
    expect(
      formatScopeClauseValidationError(
        { code: 'noActions', clauseIndex: 0 },
        intl,
      ),
    ).toBe('Clause 1: grant at least one permission');
  });

  it('formats noActions for clauseIndex 1 → "Clause 2"', () => {
    expect(
      formatScopeClauseValidationError(
        { code: 'noActions', clauseIndex: 1 },
        intl,
      ),
    ).toBe('Clause 2: grant at least one permission');
  });

  it('formats blankAction with 1-based clause + action indices', () => {
    expect(
      formatScopeClauseValidationError(
        { code: 'blankAction', clauseIndex: 0, actionIndex: 1 },
        intl,
      ),
    ).toBe('Clause 1, action 2: must be a non-blank string');
  });
});

// ---------------------------------------------------------------------------
// <ScopeEditor>
// ---------------------------------------------------------------------------

describe('<ScopeEditor>', () => {
  it('renders the empty-state Paper when value is []', () => {
    render(
      <TestIntlProvider>
        <ScopeEditor value={[]} onChange={() => {}} />
      </TestIntlProvider>,
    );
    expect(
      screen.getByText(/No clauses yet — click "Add clause" below/i),
    ).toBeInTheDocument();
  });

  it('renders one numbered "Clause N" header per clause', () => {
    const clauses: ScopeClause[] = [
      { allowed_actions: ['read'], data_scope: {} },
      { allowed_actions: ['write'], data_scope: {} },
    ];
    render(
      <TestIntlProvider>
        <ScopeEditor value={clauses} onChange={() => {}} />
      </TestIntlProvider>,
    );
    expect(screen.getByText('Clause 1')).toBeInTheDocument();
    expect(screen.getByText('Clause 2')).toBeInTheDocument();
  });

  it('"Add clause" appends an empty clause via onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TestIntlProvider>
        <ScopeEditor value={[]} onChange={onChange} />
      </TestIntlProvider>,
    );
    await user.click(screen.getByRole('button', { name: /add clause/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([
      { allowed_actions: [], data_scope: {} },
    ]);
  });

  it('"Add clause" preserves existing clauses', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const existing: ScopeClause[] = [{ allowed_actions: ['read'], data_scope: {} }];
    render(
      <TestIntlProvider>
        <ScopeEditor value={existing} onChange={onChange} />
      </TestIntlProvider>,
    );
    await user.click(screen.getByRole('button', { name: /add clause/i }));
    expect(onChange).toHaveBeenCalledWith([
      { allowed_actions: ['read'], data_scope: {} },
      { allowed_actions: [], data_scope: {} },
    ]);
  });

  it('per-clause remove button drops the clause at its index', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const clauses: ScopeClause[] = [
      { allowed_actions: ['read'], data_scope: {} },
      { allowed_actions: ['write'], data_scope: {} },
    ];
    render(
      <TestIntlProvider>
        <ScopeEditor value={clauses} onChange={onChange} />
      </TestIntlProvider>,
    );
    // Two remove buttons share the same aria-label; the first is clause 1.
    const removeButtons = screen.getAllByRole('button', { name: /remove clause/i });
    await user.click(removeButtons[0]!);
    expect(onChange).toHaveBeenCalledWith([
      { allowed_actions: ['write'], data_scope: {} },
    ]);
  });

  it('disabled=true disables Add + Remove controls', () => {
    // Two clauses so the per-clause Remove control renders (it's hidden for a
    // lone clause — there's nothing to remove down to).
    const clauses: ScopeClause[] = [
      { allowed_actions: ['records:r'], data_scope: {} },
      { allowed_actions: ['documents:r'], data_scope: {} },
    ];
    render(
      <TestIntlProvider>
        <ScopeEditor value={clauses} onChange={() => {}} disabled />
      </TestIntlProvider>,
    );
    expect(screen.getByRole('button', { name: /add clause/i })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /remove clause/i })[0]).toBeDisabled();
  });

  it('hides the per-clause Remove control when there is only one clause', () => {
    render(
      <TestIntlProvider>
        <ScopeEditor value={[{ allowed_actions: ['records:r'], data_scope: {} }]} onChange={() => {}} />
      </TestIntlProvider>,
    );
    expect(screen.queryByRole('button', { name: /remove clause/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// parseClauseActions() / serializeClauseActions() — matrix model ⇄ wire
// ---------------------------------------------------------------------------

describe('parseClauseActions() / serializeClauseActions()', () => {
  it('parses resource:ops grants into the matrix model', () => {
    expect(parseClauseActions(['records:cru', 'search:r'])).toEqual({
      wildcard: false,
      grants: { records: 'cru', search: 'r' },
      advanced: [],
    });
  });

  it('treats "*" as the wildcard flag, not a grant', () => {
    expect(parseClauseActions(['*'])).toEqual({ wildcard: true, grants: {}, advanced: [] });
  });

  it('routes bare verbs, qualified/sensitive forms, and unknown resources to advanced (no data loss)', () => {
    expect(parseClauseActions(['read', 'records:rs:patient', 'widgets:cru'])).toEqual({
      wildcard: false,
      grants: {},
      advanced: ['read', 'records:rs:patient', 'widgets:cru'],
    });
  });

  it('routes ops not applicable to a resource to advanced (e.g. search is read-only)', () => {
    // search supports only `r`; `search:cru` can't be expressed by the matrix.
    expect(parseClauseActions(['search:cru'])).toEqual({
      wildcard: false,
      grants: {},
      advanced: ['search:cru'],
    });
  });

  it('serializes grants in canonical catalog + crud order, then advanced', () => {
    expect(
      serializeClauseActions({
        wildcard: false,
        grants: { search: 'r', records: 'urc' },
        advanced: ['records:rs:patient'],
      }),
    ).toEqual(['records:cru', 'search:r', 'records:rs:patient']);
  });

  it('wildcard serializes to ["*"], collapsing any grants', () => {
    expect(
      serializeClauseActions({ wildcard: true, grants: { records: 'cru' }, advanced: ['x:r'] }),
    ).toEqual(['*']);
  });

  it('round-trips a structured clause stringify-stably', () => {
    const actions = ['records:cru', 'documents:r'];
    expect(serializeClauseActions(parseClauseActions(actions))).toEqual(actions);
  });
});

// ---------------------------------------------------------------------------
// <ScopeEditor> — resource × CRUD matrix interaction
// ---------------------------------------------------------------------------

describe('<ScopeEditor> permission matrix', () => {
  it('reflects a loaded resource:ops grant as checked boxes', () => {
    render(
      <TestIntlProvider>
        <ScopeEditor value={[{ allowed_actions: ['records:ru'], data_scope: {} }]} onChange={() => {}} />
      </TestIntlProvider>,
    );
    expect(screen.getByRole('checkbox', { name: /read records/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /update records/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /create records/i })).not.toBeChecked();
  });

  it('toggling an op emits the resource:ops string', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TestIntlProvider>
        <ScopeEditor value={[emptyClause()]} onChange={onChange} />
      </TestIntlProvider>,
    );
    await user.click(screen.getByRole('checkbox', { name: /read records/i }));
    expect(onChange).toHaveBeenCalledWith([{ allowed_actions: ['records:r'], data_scope: {} }]);
  });

  it('"Full access" emits ["*"] and hides the matrix', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TestIntlProvider>
        <ScopeEditor value={[emptyClause()]} onChange={onChange} />
      </TestIntlProvider>,
    );
    await user.click(screen.getByRole('checkbox', { name: /full access/i }));
    expect(onChange).toHaveBeenCalledWith([{ allowed_actions: ['*'], data_scope: {} }]);
  });

  it('does not offer create/update/delete on a read-only resource (search)', () => {
    render(
      <TestIntlProvider>
        <ScopeEditor value={[emptyClause()]} onChange={() => {}} />
      </TestIntlProvider>,
    );
    expect(screen.getByRole('checkbox', { name: /read search/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /create search/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /delete search/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// <ScopeEditor> — data_scope (row-level ownership) authoring
// ---------------------------------------------------------------------------

describe('<ScopeEditor> data-scope filters', () => {
  it('renders an existing scope:<ns> filter (expanded) with its value + null opt-in', () => {
    const clauses: ScopeClause[] = [
      {
        allowed_actions: ['records:r'],
        data_scope: { 'scope:org': ['org_a', null] },
      },
    ];
    render(
      <TestIntlProvider>
        <ScopeEditor value={clauses} onChange={() => {}} />
      </TestIntlProvider>,
    );
    // The namespace + value chip render, and the null opt-in is checked.
    expect(
      (screen.getByRole('combobox', { name: /scope/i }) as HTMLInputElement).value,
    ).toBe('org');
    expect(screen.getByText('org_a')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /include rows with no value/i }),
    ).toBeChecked();
  });

  it('adding a filter emits a scope:<ns> allow-list on the clause', async () => {
    const user = userEvent.setup();
    // ScopeEditor is fully controlled — a stateful harness feeds edits back so a
    // multi-step interaction (add row → type namespace → add value) renders.
    const seen: { value: ScopeClause[] } = {
      value: [{ allowed_actions: ['records:r'], data_scope: {} }],
    };
    function Harness(): React.JSX.Element {
      const [value, setValue] = useState<ScopeClause[]>(seen.value);
      return (
        <ScopeEditor
          value={value}
          onChange={(v) => {
            seen.value = v;
            setValue(v);
          }}
        />
      );
    }
    render(
      <TestIntlProvider>
        <Harness />
      </TestIntlProvider>,
    );
    // The filters accordion is collapsed for a clause with no filters — open it.
    await user.click(
      screen.getByRole('button', { name: /row-level data filters/i }),
    );
    await user.click(screen.getByRole('button', { name: /add filter/i }));

    // Fill the namespace + a value.
    await user.type(screen.getByRole('combobox', { name: /scope/i }), 'org');
    await user.type(
      screen.getByRole('combobox', { name: /allowed values/i }),
      'org_acme{enter}',
    );

    expect(seen.value[0]?.data_scope).toEqual({ 'scope:org': ['org_acme'] });
  });

  it('preserves a userId data_scope while adding a namespaced filter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TestIntlProvider>
        <ScopeEditor
          value={[
            {
              allowed_actions: ['records:r'],
              data_scope: { userId: 'usr_1', 'scope:org': ['org_a'] },
            },
          ]}
          onChange={onChange}
        />
      </TestIntlProvider>,
    );
    // Toggle the null opt-in on the existing org filter.
    await user.click(
      screen.getByRole('checkbox', { name: /include rows with no value/i }),
    );
    const last = onChange.mock.calls.at(-1)?.[0] as ScopeClause[];
    // userId survives; org gains the null opt-in.
    expect(last[0]?.data_scope).toEqual({
      userId: 'usr_1',
      'scope:org': ['org_a', null],
    });
  });
});

// ---------------------------------------------------------------------------
// validateClauses() — data_scope branch
// ---------------------------------------------------------------------------

describe('validateClauses() — data_scope', () => {
  it('rejects a reserved data_scope namespace', () => {
    expect(
      validateClauses([
        { allowed_actions: ['records:r'], data_scope: { 'scope:tenant': ['x'] } },
      ]),
    ).toEqual({ code: 'dataScopeReserved', clauseIndex: 0, namespace: 'tenant' });
  });

  it('rejects a data_scope filter with no values and no null opt-in', () => {
    // An empty allow-list array is a started-but-valueless filter.
    expect(
      validateClauses([
        { allowed_actions: ['records:r'], data_scope: { 'scope:org': [] } },
      ]),
    ).toEqual({ code: 'dataScopeNoValues', clauseIndex: 0 });
  });

  it('rejects more than two data_scope namespaces on a clause', () => {
    expect(
      validateClauses([
        {
          allowed_actions: ['records:r'],
          data_scope: {
            'scope:org': ['a'],
            'scope:client': ['b'],
            'scope:group': ['c'],
          },
        },
      ]),
    ).toEqual({ code: 'dataScopeTooMany', clauseIndex: 0, max: 2 });
  });

  it('accepts a well-formed data_scope filter', () => {
    expect(
      validateClauses([
        {
          allowed_actions: ['records:r'],
          data_scope: { 'scope:org': ['org_a', null] },
        },
      ]),
    ).toBeNull();
  });
});
