// ---------------------------------------------------------------------------
// identityOverrides — parse / serialize / dirty-compare / validate.
//
// A `scope:org`-keyed override must be visible in the form and survive a save,
// and a custom `scope:<ns>` override must round-trip with zero loss.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  canonicalOverridesKey,
  canonicalOverridesKeyOfModel,
  countOverrideNamespaces,
  emptyIdentityOverrides,
  identityOverridesRequestValue,
  parseIdentityOverrides,
  serializeIdentityOverrides,
  sessionHoldsAnyIdentity,
  sessionIdentityMatchesOverrides,
  validateIdentityOverrides,
} from './identityOverrides';

describe('parseIdentityOverrides', () => {
  it('reads org/client from the canonical scope:<ns> keys', () => {
    const model = parseIdentityOverrides({
      'scope:org': 'org_123',
      'scope:client': 'cli_456',
    });
    expect(model.org).toBe('org_123');
    expect(model.client).toBe('cli_456');
    expect(model.extras).toEqual([]);
    expect(model.passthrough).toEqual({});
  });

  it('does not treat a bare `orgId` key as an org override (canonical scope:<ns> only)', () => {
    // `orgId`/`clientId` are not part of the wire vocabulary; `scope:org`
    // populates the org field while a bare `orgId` rides through passthrough.
    const model = parseIdentityOverrides({ 'scope:org': 'canon', orgId: 'legacy' });
    expect(model.org).toBe('canon');
    expect(model.passthrough).toEqual({ orgId: 'legacy' });
  });

  it('places custom namespaces in extras (in encounter order)', () => {
    const model = parseIdentityOverrides({
      'scope:group': 'eng',
      'scope:region': 'us',
    });
    expect(model.extras).toEqual([
      { namespace: 'group', value: 'eng' },
      { namespace: 'region', value: 'us' },
    ]);
  });

  it('preserves an unmodellable key verbatim in passthrough', () => {
    const model = parseIdentityOverrides({ weird: { nested: true } });
    expect(model.passthrough).toEqual({ weird: { nested: true } });
    expect(model.org).toBe('');
  });

  it('treats a null/undefined/empty map as no overrides', () => {
    expect(parseIdentityOverrides(null)).toEqual(emptyIdentityOverrides());
    expect(parseIdentityOverrides(undefined)).toEqual(emptyIdentityOverrides());
    expect(parseIdentityOverrides({})).toEqual(emptyIdentityOverrides());
  });
});

describe('serializeIdentityOverrides', () => {
  it('emits the canonical scope:<ns> form and omits blanks', () => {
    const wire = serializeIdentityOverrides({
      org: 'org_1',
      client: '',
      extras: [{ namespace: 'group', value: 'eng' }],
      passthrough: {},
    });
    expect(wire).toEqual({ 'scope:org': 'org_1', 'scope:group': 'eng' });
  });

  it('drops half-filled extra rows (namespace or value blank)', () => {
    const wire = serializeIdentityOverrides({
      org: '',
      client: '',
      extras: [
        { namespace: 'group', value: '' },
        { namespace: '', value: 'x' },
      ],
      passthrough: {},
    });
    expect(wire).toEqual({});
  });

  it('re-emits passthrough keys unchanged', () => {
    const wire = serializeIdentityOverrides({
      org: '',
      client: '',
      extras: [],
      passthrough: { weird: 'keep' },
    });
    expect(wire).toEqual({ weird: 'keep' });
  });
});

describe('round-trip (the zero-loss golden)', () => {
  it('a scope:org + custom scope:group override survives parse→serialize with zero loss', () => {
    const raw = { 'scope:org': 'org_x', 'scope:group': 'eng-team' };
    const back = serializeIdentityOverrides(parseIdentityOverrides(raw));
    expect(back).toEqual(raw);
  });
});

describe('canonical dirty-compare', () => {
  it('is key-order independent', () => {
    expect(canonicalOverridesKey({ 'scope:org': 'o', 'scope:client': 'c' })).toBe(
      canonicalOverridesKey({ 'scope:client': 'c', 'scope:org': 'o' }),
    );
  });

  it('a freshly parsed model matches its source (no spurious dirty)', () => {
    const raw = { 'scope:org': 'o', 'scope:group': 'g' };
    expect(canonicalOverridesKeyOfModel(parseIdentityOverrides(raw))).toBe(
      canonicalOverridesKey(raw),
    );
  });

  it('detects a real edit to a custom namespace', () => {
    const model = parseIdentityOverrides({ 'scope:group': 'eng' });
    const edited = { ...model, extras: [{ namespace: 'group', value: 'sales' }] };
    expect(canonicalOverridesKeyOfModel(edited)).not.toBe(
      canonicalOverridesKey({ 'scope:group': 'eng' }),
    );
  });
});

describe('sessionHoldsAnyIdentity', () => {
  it('is false for an empty identity claim (an OWNER session)', () => {
    expect(sessionHoldsAnyIdentity({})).toBe(false);
  });

  it('is false for a claim that carries only partnerUserId (no ownership dimension)', () => {
    expect(sessionHoldsAnyIdentity({ partnerUserId: 'u_123' })).toBe(false);
  });

  it('is true once the session holds a real ownership dimension', () => {
    expect(sessionHoldsAnyIdentity({ partnerUserId: 'u_123', 'scope:org': 'org_a' })).toBe(true);
  });
});

describe('sessionIdentityMatchesOverrides', () => {
  it('trivially matches a null/absent overrides map (nothing to displace or confer)', () => {
    expect(sessionIdentityMatchesOverrides({}, null)).toBe(true);
    expect(sessionIdentityMatchesOverrides({}, undefined)).toBe(true);
    expect(sessionIdentityMatchesOverrides({ 'scope:org': 'org_a' }, null)).toBe(true);
  });

  it('trivially matches an empty overrides map', () => {
    expect(sessionIdentityMatchesOverrides({ 'scope:org': 'org_a' }, {})).toBe(true);
  });

  it('matches when the session holds EXACTLY the same value for every key', () => {
    expect(
      sessionIdentityMatchesOverrides(
        { 'scope:org': 'org_a', 'scope:client': 'cli_x' },
        { 'scope:org': 'org_a', 'scope:client': 'cli_x' },
      ),
    ).toBe(true);
  });

  it('does not match when the session holds nothing for a key the overrides carry', () => {
    expect(sessionIdentityMatchesOverrides({}, { 'scope:org': 'org_a' })).toBe(false);
  });

  it('does not match a DIFFERENT value on the same key — equality, not subset', () => {
    expect(
      sessionIdentityMatchesOverrides({ 'scope:org': 'org_b' }, { 'scope:org': 'org_a' }),
    ).toBe(false);
  });

  it('extra keys the session holds but the overrides map does not mention are irrelevant', () => {
    expect(
      sessionIdentityMatchesOverrides(
        { 'scope:org': 'org_a', 'scope:client': 'cli_x' },
        { 'scope:org': 'org_a' },
      ),
    ).toBe(true);
  });

  it('one mismatched key among several fails the whole map', () => {
    expect(
      sessionIdentityMatchesOverrides(
        { 'scope:org': 'org_a', 'scope:client': 'WRONG' },
        { 'scope:org': 'org_a', 'scope:client': 'cli_x' },
      ),
    ).toBe(false);
  });
});

// The exact function `ProfileEditor.buildBody()` calls to decide what to put
// in the save request — tested directly here, independent of any UI state
// (in particular: independent of whether the editor's fields are enabled),
// so both directions are provable regardless of that disablement.
describe('identityOverridesRequestValue', () => {
  it('CREATE: a non-empty model is sent (nothing to compare against yet)', () => {
    const model = parseIdentityOverrides({ 'scope:org': 'o' });
    expect(identityOverridesRequestValue(model, undefined, true)).toEqual({
      'scope:org': 'o',
    });
  });

  it('CREATE: an empty model is omitted', () => {
    expect(identityOverridesRequestValue(emptyIdentityOverrides(), undefined, true)).toBeUndefined();
  });

  it('EDIT: a genuine change from the baseline IS sent — the positive control for the fix below', () => {
    const baseline = { 'scope:org': 'org_a' };
    const edited = parseIdentityOverrides({ 'scope:org': 'org_b' });
    expect(identityOverridesRequestValue(edited, baseline, false)).toEqual({
      'scope:org': 'org_b',
    });
  });

  it('EDIT: an UNCHANGED, non-empty model vs. its own baseline is omitted — the regression this function fixes', () => {
    const baseline = { 'scope:org': 'org_a', 'scope:group': 'eng' };
    const unchanged = parseIdentityOverrides(baseline);
    expect(identityOverridesRequestValue(unchanged, baseline, false)).toBeUndefined();
  });

  it('EDIT: reads through the canonical form — a re-ordered/re-spread baseline of the SAME overrides still reads unchanged', () => {
    const baseline = { 'scope:group': 'eng', 'scope:org': 'org_a' };
    const sameButReordered = parseIdentityOverrides({
      'scope:org': 'org_a',
      'scope:group': 'eng',
    });
    expect(identityOverridesRequestValue(sameButReordered, baseline, false)).toBeUndefined();
  });

  it('EDIT: clearing a non-empty baseline sends an explicit {} — an omitted field means "leave as-is", so a real clear has to say so', () => {
    const baseline = { 'scope:org': 'org_a' };
    expect(
      identityOverridesRequestValue(emptyIdentityOverrides(), baseline, false),
    ).toEqual({});
  });

  it('EDIT: an already-empty model against an already-empty baseline stays omitted (nothing changed)', () => {
    expect(
      identityOverridesRequestValue(emptyIdentityOverrides(), undefined, false),
    ).toBeUndefined();
    expect(
      identityOverridesRequestValue(emptyIdentityOverrides(), {}, false),
    ).toBeUndefined();
  });
});

describe('countOverrideNamespaces', () => {
  it('counts non-blank org, client, and completed extras', () => {
    expect(
      countOverrideNamespaces({
        org: 'o',
        client: '',
        extras: [
          { namespace: 'group', value: 'g' },
          { namespace: 'region', value: '' },
        ],
        passthrough: {},
      }),
    ).toBe(2);
  });
});

describe('validateIdentityOverrides', () => {
  const base = emptyIdentityOverrides();

  it('accepts an empty model', () => {
    expect(validateIdentityOverrides(base)).toBeNull();
  });

  it('ignores a fully-blank extra row', () => {
    expect(
      validateIdentityOverrides({ ...base, extras: [{ namespace: '', value: '' }] }),
    ).toBeNull();
  });

  it('rejects a reserved namespace', () => {
    const err = validateIdentityOverrides({
      ...base,
      extras: [{ namespace: 'tenant', value: 'x' }],
    });
    expect(err).toEqual({
      code: 'extraNamespace',
      index: 0,
      error: { code: 'reserved', namespace: 'tenant' },
    });
  });

  it('directs a built-in namespace to its dedicated field', () => {
    const err = validateIdentityOverrides({
      ...base,
      extras: [{ namespace: 'org', value: 'x' }],
    });
    expect(err).toEqual({ code: 'extraBuiltin', index: 0, namespace: 'org' });
  });

  it('rejects a namespace that breaks the grammar', () => {
    const err = validateIdentityOverrides({
      ...base,
      extras: [{ namespace: 'Bad Ns', value: 'x' }],
    });
    expect(err?.code).toBe('extraNamespace');
  });

  it('requires a value when a namespace is given', () => {
    const err = validateIdentityOverrides({
      ...base,
      extras: [{ namespace: 'group', value: '' }],
    });
    expect(err).toEqual({ code: 'extraMissingValue', index: 0 });
  });

  it('rejects a duplicate namespace', () => {
    const err = validateIdentityOverrides({
      ...base,
      extras: [
        { namespace: 'group', value: 'a' },
        { namespace: 'group', value: 'b' },
      ],
    });
    expect(err).toEqual({ code: 'extraDuplicate', index: 1, namespace: 'group' });
  });

  it('rejects more than two total scope namespaces', () => {
    const err = validateIdentityOverrides({
      org: 'o',
      client: 'c',
      extras: [{ namespace: 'group', value: 'g' }],
      passthrough: {},
    });
    expect(err).toEqual({ code: 'tooManyNamespaces', max: 2 });
  });

  // org/client/extra values now run the platform's scope-value grammar, not
  // just a blank check.
  it('rejects an org value that breaks the scope-value grammar', () => {
    const err = validateIdentityOverrides({ ...base, org: 'a:b' });
    expect(err).toEqual({ code: 'orgInvalidValue' });
  });

  it('rejects a client value that breaks the scope-value grammar', () => {
    const err = validateIdentityOverrides({ ...base, client: 'a b' });
    expect(err).toEqual({ code: 'clientInvalidValue' });
  });

  it('rejects an extra value that breaks the scope-value grammar', () => {
    const err = validateIdentityOverrides({
      ...base,
      extras: [{ namespace: 'group', value: 'eng:team' }],
    });
    expect(err).toEqual({ code: 'extraInvalidValue', index: 0 });
  });

  it('still requires a value before checking its grammar (extraMissingValue wins)', () => {
    const err = validateIdentityOverrides({
      ...base,
      extras: [{ namespace: 'group', value: '' }],
    });
    expect(err).toEqual({ code: 'extraMissingValue', index: 0 });
  });

  it('accepts a well-formed org/client value (positive control)', () => {
    expect(
      validateIdentityOverrides({
        org: 'org_123',
        client: 'cli-456',
        extras: [],
        passthrough: {},
      }),
    ).toBeNull();
  });

  it('accepts a well-formed extra value (positive control)', () => {
    expect(
      validateIdentityOverrides({
        ...base,
        extras: [{ namespace: 'group', value: 'eng-team' }],
      }),
    ).toBeNull();
  });
});
