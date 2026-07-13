// ---------------------------------------------------------------------------
// dataScope — parse / serialize / validate for a clause's row-level filters.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  canonicalDataScopeKey,
  countDataScopeNamespaces,
  emptyDataScope,
  parseDataScope,
  serializeDataScope,
  validateDataScope,
} from './dataScope';

describe('parseDataScope', () => {
  it('reads namespaced allow-lists and folds null into includeNull', () => {
    const model = parseDataScope({
      'scope:org': ['org_a', 'org_b', null],
      'scope:group': ['eng'],
    });
    expect(model.dimensions).toEqual([
      { namespace: 'org', values: ['org_a', 'org_b'], includeNull: true },
      { namespace: 'group', values: ['eng'], includeNull: false },
    ]);
    expect(model.passthrough).toEqual({});
  });

  it('accepts orgId/clientId shorthand keys', () => {
    const model = parseDataScope({ orgId: ['o'], clientId: ['c'] });
    expect(model.dimensions.map((d) => d.namespace)).toEqual(['org', 'client']);
  });

  it('preserves userId + non-array values in passthrough', () => {
    const model = parseDataScope({ userId: 'usr_1', 'scope:org': 'not-an-array' });
    expect(model.dimensions).toEqual([]);
    expect(model.passthrough).toEqual({ userId: 'usr_1', 'scope:org': 'not-an-array' });
  });

  it('treats null/empty as match-all', () => {
    expect(parseDataScope(null)).toEqual(emptyDataScope());
    expect(parseDataScope({})).toEqual(emptyDataScope());
  });
});

describe('serializeDataScope', () => {
  it('emits canonical scope:<ns> allow-lists with the null opt-in appended', () => {
    const wire = serializeDataScope({
      dimensions: [{ namespace: 'org', values: ['org_a'], includeNull: true }],
      passthrough: {},
    });
    expect(wire).toEqual({ 'scope:org': ['org_a', null] });
  });

  it('drops a fully-blank dimension (no namespace)', () => {
    const wire = serializeDataScope({
      dimensions: [{ namespace: '', values: [''], includeNull: false }],
      passthrough: {},
    });
    expect(wire).toEqual({});
  });

  it('emits an empty list for a NAMED dimension with no values (so it is catchable, not silently dropped)', () => {
    const wire = serializeDataScope({
      dimensions: [{ namespace: 'org', values: [''], includeNull: false }],
      passthrough: {},
    });
    expect(wire).toEqual({ 'scope:org': [] });
    // …and the round-trip flags it rather than broadening the clause.
    expect(validateDataScope(parseDataScope(wire))).toEqual({ code: 'noValues', index: 0 });
  });

  it('merges duplicate namespaces (union of values) instead of last-wins clobber', () => {
    const wire = serializeDataScope({
      dimensions: [
        { namespace: 'org', values: ['a'], includeNull: false },
        { namespace: 'org', values: ['b', 'a'], includeNull: true },
      ],
      passthrough: {},
    });
    expect(wire).toEqual({ 'scope:org': ['a', 'b', null] });
  });

  it('emits a null-only list when only the opt-in is set', () => {
    const wire = serializeDataScope({
      dimensions: [{ namespace: 'org', values: [], includeNull: true }],
      passthrough: {},
    });
    expect(wire).toEqual({ 'scope:org': [null] });
  });

  it('carries userId passthrough through unchanged', () => {
    const wire = serializeDataScope({
      dimensions: [],
      passthrough: { userId: 'usr_1' },
    });
    expect(wire).toEqual({ userId: 'usr_1' });
  });
});

describe('round-trip', () => {
  it('preserves a userId + namespaced filter with zero loss', () => {
    const raw = { userId: 'usr_1', 'scope:org': ['org_a', null] };
    expect(serializeDataScope(parseDataScope(raw))).toEqual(raw);
  });

  it('normalizes orgId shorthand to scope:org', () => {
    expect(serializeDataScope(parseDataScope({ orgId: ['o'] }))).toEqual({
      'scope:org': ['o'],
    });
  });

  it('canonical key is order-independent', () => {
    expect(canonicalDataScopeKey({ 'scope:org': ['o'], 'scope:client': ['c'] })).toBe(
      canonicalDataScopeKey({ 'scope:client': ['c'], 'scope:org': ['o'] }),
    );
  });
});

describe('countDataScopeNamespaces', () => {
  it('counts only active, named dimensions', () => {
    expect(
      countDataScopeNamespaces({
        dimensions: [
          { namespace: 'org', values: ['o'], includeNull: false },
          { namespace: '', values: [], includeNull: false },
        ],
        passthrough: {},
      }),
    ).toBe(1);
  });
});

describe('validateDataScope', () => {
  const base = emptyDataScope();

  it('accepts an empty model + a fully-blank dimension', () => {
    expect(validateDataScope(base)).toBeNull();
    expect(
      validateDataScope({
        dimensions: [{ namespace: '', values: [], includeNull: false }],
        passthrough: {},
      }),
    ).toBeNull();
  });

  it('allows the built-in namespaces (no dedicated fields to defer to)', () => {
    expect(
      validateDataScope({
        dimensions: [{ namespace: 'org', values: ['o'], includeNull: false }],
        passthrough: {},
      }),
    ).toBeNull();
  });

  it('rejects a reserved namespace', () => {
    const err = validateDataScope({
      dimensions: [{ namespace: 'scope', values: ['x'], includeNull: false }],
      passthrough: {},
    });
    expect(err).toEqual({
      code: 'namespace',
      index: 0,
      error: { code: 'reserved', namespace: 'scope' },
    });
  });

  it('requires a value or the null opt-in', () => {
    const err = validateDataScope({
      dimensions: [{ namespace: 'org', values: [''], includeNull: false }],
      passthrough: {},
    });
    expect(err).toEqual({ code: 'noValues', index: 0 });
  });

  it('accepts a dimension whose only signal is the null opt-in', () => {
    expect(
      validateDataScope({
        dimensions: [{ namespace: 'org', values: [], includeNull: true }],
        passthrough: {},
      }),
    ).toBeNull();
  });

  it('rejects duplicate namespaces', () => {
    const err = validateDataScope({
      dimensions: [
        { namespace: 'org', values: ['a'], includeNull: false },
        { namespace: 'org', values: ['b'], includeNull: false },
      ],
      passthrough: {},
    });
    expect(err).toEqual({ code: 'duplicate', index: 1, namespace: 'org' });
  });

  it('rejects more than two dimensions', () => {
    const err = validateDataScope({
      dimensions: [
        { namespace: 'org', values: ['a'], includeNull: false },
        { namespace: 'client', values: ['b'], includeNull: false },
        { namespace: 'group', values: ['c'], includeNull: false },
      ],
      passthrough: {},
    });
    expect(err).toEqual({ code: 'tooManyNamespaces', max: 2 });
  });
});
