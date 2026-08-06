// ---------------------------------------------------------------------------
// dataScope — parse / serialize / validate for a clause's row-level filters.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  DIMENSION_WILDCARD,
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

  it('routes a bare `orgId` key (not a canonical scope key) to passthrough', () => {
    // `orgId`/`clientId` are NOT scope keys — only canonical `scope:<ns>` is
    // modelled; a bare `orgId` rides through passthrough untouched.
    const model = parseDataScope({ orgId: ['o'], 'scope:group': ['eng'] });
    expect(model.dimensions.map((d) => d.namespace)).toEqual(['group']);
    expect(model.passthrough).toEqual({ orgId: ['o'] });
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

  // The "*" dimension wildcard (0.38.0) is a BARE key, not scope:* — it must
  // parse as a dimension, not fall through to passthrough.
  it('reads the "*" dimension wildcard as a dimension, not passthrough', () => {
    const model = parseDataScope({ '*': ['${{ any }}', null] });
    expect(model.dimensions).toEqual([
      { namespace: DIMENSION_WILDCARD, values: ['${{ any }}'], includeNull: true },
    ]);
    expect(model.passthrough).toEqual({});
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

  it('emits the "*" dimension wildcard as a BARE key, not scope:*', () => {
    const wire = serializeDataScope({
      dimensions: [{ namespace: DIMENSION_WILDCARD, values: ['${{ any }}'], includeNull: true }],
      passthrough: {},
    });
    expect(wire).toEqual({ '*': ['${{ any }}', null] });
  });
});

describe('round-trip', () => {
  it('preserves a userId + namespaced filter with zero loss', () => {
    const raw = { userId: 'usr_1', 'scope:org': ['org_a', null] };
    expect(serializeDataScope(parseDataScope(raw))).toEqual(raw);
  });

  it('preserves the "*" dimension wildcard with zero loss', () => {
    const raw = { '*': ['${{ any }}', null] };
    expect(serializeDataScope(parseDataScope(raw))).toEqual(raw);
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

  // The "*" dimension wildcard is a KEY, not a `scope:<ns>` namespace — before
  // this it failed the ordinary a-z namespace grammar (SCOPE_NAMESPACE_PATTERN
  // rejects a leading `*`), so the UI could not author 0.38.0's new wildcard
  // at all: any attempt to save one hit a `namespace`/`grammar` error.
  it('accepts the "*" dimension wildcard (bypasses the ordinary namespace grammar)', () => {
    expect(
      validateDataScope({
        dimensions: [
          { namespace: DIMENSION_WILDCARD, values: ['${{ any }}'], includeNull: true },
        ],
        passthrough: {},
      }),
    ).toBeNull();
  });

  it('still requires a value (or the null opt-in) on the "*" dimension', () => {
    const err = validateDataScope({
      dimensions: [{ namespace: DIMENSION_WILDCARD, values: [''], includeNull: false }],
      passthrough: {},
    });
    expect(err).toEqual({ code: 'noValues', index: 0 });
  });

  it('rejects a duplicate "*" dimension the same as any other duplicate', () => {
    const err = validateDataScope({
      dimensions: [
        { namespace: DIMENSION_WILDCARD, values: ['a'], includeNull: false },
        { namespace: DIMENSION_WILDCARD, values: ['b'], includeNull: false },
      ],
      passthrough: {},
    });
    expect(err).toEqual({ code: 'duplicate', index: 1, namespace: DIMENSION_WILDCARD });
  });
});
