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
  RESOURCE_CATALOG,
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
    expect(emptyClause()).toEqual({
      allowed_actions: [],
      data_scope: {},
      granted_capabilities: [],
    });
  });

  it('returns a fresh instance each call (no shared references)', () => {
    const a = emptyClause();
    const b = emptyClause();
    expect(a).not.toBe(b);
    expect(a.allowed_actions).not.toBe(b.allowed_actions);
    expect(a.data_scope).not.toBe(b.data_scope);
    expect(a.granted_capabilities).not.toBe(b.granted_capabilities);
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
    const scope = { allowed_actions: ['read'], data_scope: { 'scope:org': ['org_1'] } };
    expect(normalizeScopes([scope])).toEqual([
      { allowed_actions: ['read'], data_scope: { 'scope:org': ['org_1'] }, granted_capabilities: [] },
    ]);
  });

  it('carries granted_capabilities through untouched (0.40.0 — the same class of bug: a role/profile carrying a capability grant must not lose it on load/save)', () => {
    const scope = {
      allowed_actions: ['users:crud'],
      data_scope: {},
      granted_capabilities: ['member-lifecycle', 'delegate-mint'],
    };
    expect(normalizeScopes([scope])).toEqual([
      {
        allowed_actions: ['users:crud'],
        data_scope: {},
        granted_capabilities: ['member-lifecycle', 'delegate-mint'],
      },
    ]);
  });

  it('defaults missing allowed_actions / data_scope / granted_capabilities per clause', () => {
    expect(normalizeScopes([{ allowed_actions: ['read'] }])).toEqual([
      { allowed_actions: ['read'], data_scope: {}, granted_capabilities: [] },
    ]);
    expect(normalizeScopes([{ data_scope: { a: 1 } }])).toEqual([
      { allowed_actions: [], data_scope: { a: 1 }, granted_capabilities: [] },
    ]);
  });

  it('copies into fresh inner arrays (no aliasing of the source)', () => {
    const src = [
      { allowed_actions: ['read'], data_scope: {}, granted_capabilities: ['forensic-read'] },
    ];
    const out = normalizeScopes(src);
    expect(out[0]?.allowed_actions).not.toBe(src[0]?.allowed_actions);
    expect(out[0]?.allowed_actions).toEqual(['read']);
    expect(out[0]?.granted_capabilities).not.toBe(src[0]?.granted_capabilities);
    expect(out[0]?.granted_capabilities).toEqual(['forensic-read']);
  });

  it('round-trips so a re-normalized clause list is stringify-stable (clean-on-load)', () => {
    // The editors seed `scopes` via normalizeScopes AND compare against
    // normalizeScopes(baseline) — so a pristine load must compare equal.
    const loaded = [
      {
        allowed_actions: ['records:r', 'documents:r'],
        data_scope: {},
        granted_capabilities: ['context-directory-read'],
      },
    ];
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

describe('RESOURCE_CATALOG (grantable scope resources)', () => {
  it('offers `entities` and NOT the retired org/client — nor the inert `namespaces`', () => {
    const values = RESOURCE_CATALOG.map((r) => r.value);
    // The generic IdentityEntityDB surface replaced the retired org/client routes.
    expect(values).toContain('entities');
    // `orgs`/`clients` are dead authority (routes 404) — no longer grantable.
    expect(values).not.toContain('orgs');
    expect(values).not.toContain('clients');
    // `namespaces` is delisted as a grantable resource (registry reads are open,
    // writes are root-key only) — a `namespaces:<verb>` grant would be inert, so
    // the matrix must not offer it as a false affordance.
    expect(values).not.toContain('namespaces');
  });

  it('has an i18n label for every catalog resource', () => {
    for (const { value } of RESOURCE_CATALOG) {
      expect(
        (enMessages as Record<string, string>)[`scopeEditor.resource.${value}`],
      ).toBeTruthy();
    }
  });
});

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
      { allowed_actions: [], data_scope: {}, granted_capabilities: [] },
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
      { allowed_actions: [], data_scope: {}, granted_capabilities: [] },
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

  describe('granted_capabilities authoring (0.40.0)', () => {
    it('renders a checkbox for each of the two admin-app-authorable capabilities, unchecked by default', async () => {
      const user = userEvent.setup();
      render(
        <TestIntlProvider>
          <ScopeEditor value={[{ allowed_actions: ['users:crud'], data_scope: {} }]} onChange={() => {}} />
        </TestIntlProvider>,
      );
      // The capabilities accordion is collapsed for a clause with none — open it.
      await user.click(
        screen.getByRole('button', { name: /platform capabilities/i }),
      );
      for (const name of [/member-lifecycle/i, /delegate-mint/i]) {
        const checkbox = screen.getByRole('checkbox', { name });
        expect(checkbox).not.toBeChecked();
      }
    });

    it('does NOT offer forensic-read or context-directory-read as checkboxes — admin-app\'s own bearer can never back either by design, so a checkbox would always 403', async () => {
      const user = userEvent.setup();
      render(
        <TestIntlProvider>
          <ScopeEditor value={[{ allowed_actions: ['users:crud'], data_scope: {} }]} onChange={() => {}} />
        </TestIntlProvider>,
      );
      await user.click(
        screen.getByRole('button', { name: /platform capabilities/i }),
      );
      expect(screen.queryByRole('checkbox', { name: /forensic-read/i })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('checkbox', { name: /context-directory-read/i }),
      ).not.toBeInTheDocument();
    });

    it('renders pre-checked boxes for capabilities the loaded clause already carries', () => {
      render(
        <TestIntlProvider>
          <ScopeEditor
            value={[
              {
                allowed_actions: ['users:crud'],
                data_scope: {},
                granted_capabilities: ['delegate-mint'],
              },
            ]}
            onChange={() => {}}
          />
        </TestIntlProvider>,
      );
      expect(screen.getByRole('checkbox', { name: /delegate-mint/i })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /member-lifecycle/i })).not.toBeChecked();
    });

    it('checking a capability adds exactly that name, preserving the others untouched', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <TestIntlProvider>
          <ScopeEditor
            value={[
              {
                allowed_actions: ['users:crud'],
                data_scope: {},
                granted_capabilities: ['forensic-read'],
              },
            ]}
            onChange={onChange}
          />
        </TestIntlProvider>,
      );
      await user.click(screen.getByRole('checkbox', { name: /delegate-mint/i }));
      // Canonicalized: known names (catalog order) first, then anything this
      // editor doesn't offer — not insertion order. Semantically the same set
      // either way; canonicalizing is what keeps an uncheck-then-recheck from
      // reordering the array and reading as a spurious edit.
      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({
          granted_capabilities: ['delegate-mint', 'forensic-read'],
        }),
      ]);
    });

    it('unchecking a capability removes only that exact name, leaving entries this editor does not offer alone (forensic-read is not admin-app-authorable, and neither is a future-release name)', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <TestIntlProvider>
          <ScopeEditor
            value={[
              {
                allowed_actions: ['users:crud'],
                data_scope: {},
                granted_capabilities: ['forensic-read', 'some-future-capability', 'member-lifecycle'],
              },
            ]}
            onChange={onChange}
          />
        </TestIntlProvider>,
      );
      await user.click(screen.getByRole('checkbox', { name: /member-lifecycle/i }));
      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({
          granted_capabilities: ['forensic-read', 'some-future-capability'],
        }),
      ]);
    });

    it('unchecking then rechecking a capability settles to a stable canonical order, not the pre-toggle insertion order (dirty-state stability)', async () => {
      // Starts in a NON-canonical order (as it might load from the server —
      // order is not semantically meaningful there). Before canonicalization,
      // toggling always appended at the END, so an uncheck+recheck round-trip
      // would leave the array in a DIFFERENT order than either the original
      // OR a second uncheck+recheck — a spurious diff a JSON.stringify-based
      // dirty check would misread as a real edit.
      const user = userEvent.setup();
      const seen: { value: ScopeClause[] } = {
        value: [
          {
            allowed_actions: ['users:crud'],
            data_scope: {},
            granted_capabilities: ['delegate-mint', 'member-lifecycle'],
          },
        ],
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
      // The accordion is already expanded — the seeded clause has 2
      // capabilities (`defaultExpanded={capabilities.length > 0}`) — so no
      // click is needed to open it here (unlike the empty-clause tests
      // above).
      const memberLifecycle = screen.getByRole('checkbox', { name: /member-lifecycle/i });
      await user.click(memberLifecycle); // uncheck
      await user.click(memberLifecycle); // recheck
      const afterOneRoundTrip = [...seen.value[0]!.granted_capabilities!];

      await user.click(memberLifecycle); // uncheck again
      await user.click(memberLifecycle); // recheck again
      const afterTwoRoundTrips = [...seen.value[0]!.granted_capabilities!];

      // Stable: a second round-trip produces the SAME array as the first —
      // not still drifting — and it's the canonical (catalog-order) form,
      // not the original insertion order.
      expect(afterOneRoundTrip).toEqual(['member-lifecycle', 'delegate-mint']);
      expect(afterTwoRoundTrips).toEqual(afterOneRoundTrip);
    });
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
    expect(onChange).toHaveBeenCalledWith([
      { allowed_actions: ['records:r'], data_scope: {}, granted_capabilities: [] },
    ]);
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
    expect(onChange).toHaveBeenCalledWith([
      { allowed_actions: ['*'], data_scope: {}, granted_capabilities: [] },
    ]);
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

  // The "*" dimension wildcard (0.38.0) previously could not be authored at
  // all through this editor — the namespace field's grammar rejected a
  // leading "*". Both the option's discoverability and the actual save path
  // are pinned here, not just the underlying dataScope.ts model.
  it('offers "*" as a namespace suggestion and saves it as the bare wildcard key', async () => {
    const user = userEvent.setup();
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
    await user.click(
      screen.getByRole('button', { name: /row-level data filters/i }),
    );
    await user.click(screen.getByRole('button', { name: /add filter/i }));

    const namespaceInput = screen.getByRole('combobox', { name: /scope/i });
    await user.click(namespaceInput);
    // "*" is offered alongside the built-ins, not just typeable blind.
    expect(await screen.findByRole('option', { name: '*' })).toBeInTheDocument();
    await user.type(namespaceInput, '*');

    // Pick the suggested matcher from the values dropdown rather than typing
    // it — the literal `${{ }}` braces are userEvent.type() special-key
    // syntax, and clicking the option is also the real UX this feature is
    // FOR ("pick one from the value field's suggestions").
    const valuesInput = screen.getByRole('combobox', { name: /allowed values/i });
    await user.click(valuesInput);
    await user.click(await screen.findByRole('option', { name: '${{ any }}' }));

    // The bare "*" key, not "scope:*" — the whole point of the sentinel.
    expect(seen.value[0]?.data_scope).toEqual({ '*': ['${{ any }}'] });
  });

  it('suggests the placement matchers in the values field once a namespace is entered', async () => {
    const user = userEvent.setup();
    render(
      <TestIntlProvider>
        <ScopeEditor
          value={[{ allowed_actions: ['records:r'], data_scope: { 'scope:org': [] } }]}
          onChange={() => {}}
        />
      </TestIntlProvider>,
    );
    const valuesInput = screen.getByRole('combobox', { name: /allowed values/i });
    await user.click(valuesInput);
    expect(await screen.findByRole('option', { name: '${{ any }}' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: '${{ under.self.userId }}' }),
    ).toBeInTheDocument();
    // The namespace-scoped matcher is templated with THIS row's namespace.
    expect(
      screen.getByRole('option', { name: '${{ under.self.scope.org }}' }),
    ).toBeInTheDocument();
    // Built-in namespaces are always offered as cross-reference candidates,
    // even with only one dimension row authored.
    expect(
      screen.getByRole('option', { name: '${{ under.self.scope.client }}' }),
    ).toBeInTheDocument();
  });

  // The feature's own canonical use case (0.38.0's release note): a credential
  // confined to an ORG can work with the CLIENTS under it — matcher
  // ${{ under.self.scope.org }} on the "client" ROW. Suggesting only a row's
  // own namespace would never surface the form the feature exists for.
  it('suggests a matcher for a DIFFERENT authored dimension, not only the row\'s own namespace', async () => {
    const user = userEvent.setup();
    render(
      <TestIntlProvider>
        <ScopeEditor
          value={[
            {
              allowed_actions: ['records:r'],
              // Two dimensions on one clause: org (row 0) and a custom
              // namespace "group" (row 1) — group is NOT a built-in, so it can
              // only appear as a suggestion via the other-authored-dimensions
              // path, never via the built-ins fallback.
              data_scope: { 'scope:org': [], 'scope:group': [] },
            },
          ]}
          onChange={() => {}}
        />
      </TestIntlProvider>,
    );
    const valuesInputs = screen.getAllByRole('combobox', { name: /allowed values/i });
    // Row 1 ("group") — open its values field and confirm it suggests the
    // OTHER row's namespace (org), the cross-dimension form.
    await user.click(valuesInputs[1]!);
    expect(
      await screen.findByRole('option', { name: '${{ under.self.scope.org }}' }),
    ).toBeInTheDocument();
    // And its own namespace, still offered.
    expect(
      screen.getByRole('option', { name: '${{ under.self.scope.group }}' }),
    ).toBeInTheDocument();
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
