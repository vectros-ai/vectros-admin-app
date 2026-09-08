// ---------------------------------------------------------------------------
// Conformance guard: this app's scope catalog vs the SDK's published grammar.
//
// `RESOURCE_CATALOG` and `CRUD_OPS` mirror a catalog the platform owns — the op
// letters of the compact `resource:ops[:qualifier]` form, and which resources
// carry which of them. A mirror can only ever follow, and this one had already
// fallen a letter behind: `x` (execute a stored script) shipped in the API
// while this editor's matrix, its header comment, and its user-facing Advanced
// hint all still described a four-letter world.
//
// Every OTHER test in this suite pins the catalog against literals written in
// this same file, in this same language, edited in the same commit. Those are
// worth having — they catch a half-wired letter — but they cannot catch the
// failure that actually happened, because both sides of the comparison move
// together. So this file reads the other side: the `allowed_actions` and
// `assignable_roles` declarations the SDK publishes on `ScopeClause`, generated
// from the API's own annotations.
//
// It fires on an SDK RE-PIN rather than on an edit here, which is the point —
// whoever raises the pin learns the grammar moved, in the app whose authoring
// UI has to move with it. That property costs an EQUALITY-shaped assertion and
// is not available from a subset one: the first version of this file asserted
// only `authored ⊆ named`, which is GREEN on a catalog missing a letter the SDK
// names — i.e. green on the exact drift this app had already suffered and this
// branch exists to fix. Measured, not reasoned: the pre-fix catalog was run
// against it and passed. The sibling guard this file is derived from had
// already made and corrected that mistake, in writing; this copy reverted the
// correction while keeping the header sentence the correction paid for.
//
// **What this is NOT.** It is not the deciding artifact. The API decides the
// letter set in its own authoring validator; this description is a hand-written
// prose copy of that decision and can itself lag. A green here means "the
// mirror agrees with what the SDK publishes", never "the mirror is correct".
// It is the nearest observable proxy available to an app whose only view of the
// platform is the SDK it depends on.
//
// Residual, stated rather than papered over: between the API shipping a letter
// and someone repinning, the mirror is drifted and this is green. That is
// unavoidable here and is not a reason to trust a green more than it deserves.
// ---------------------------------------------------------------------------

// This app's tsconfig deliberately withholds node types from `src` — it is a
// browser bundle, and a stray `process`/`Buffer` there should not typecheck.
// This file is the one legitimate exception: it reads the installed SDK off
// disk, which only a test ever does. Scoped here rather than by widening
// `types` for the whole app.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CRUD_OPS, RESOURCE_CATALOG } from './ScopeEditor';

/**
 * The SDK's generated `ScopeClause` type source.
 *
 * Resolved through node's own module resolution rather than a hardcoded
 * `node_modules` path, so a hoisted or a nested install both work. If a future
 * SDK reorganises that layout this throws — and a loud failure is the correct
 * outcome, because the alternative is a guard that has gone blind and says so
 * to nobody.
 */
function scopeClauseTypeSource(): string {
  const sdkEntry = createRequire(import.meta.url).resolve('@vectros-ai/sdk');
  return readFileSync(join(dirname(sdkEntry), 'api', 'types', 'ScopeClause.d.ts'), 'utf8');
}

/** The doc comment immediately above a named field, JSDoc framing stripped. */
function fieldDescription(source: string, field: string): string {
  // Tempered so the capture cannot span an EARLIER doc comment and pull another
  // field's prose in with it.
  const block = source.match(
    new RegExp(`/\\*\\*((?:(?!/\\*\\*)[\\s\\S])*?)\\*/\\s*${field}\\s*\\??\\s*:`),
  );
  if (!block?.[1]) {
    throw new Error(
      `Could not find the ${field} doc comment in the SDK's ScopeClause type. Its published ` +
        'shape changed; re-derive this guard against whatever now carries the scope grammar ' +
        'rather than deleting it.',
    );
  }
  return block[1].replace(/^\s*\*[ \t]?/gm, '');
}

describe('scope catalog conforms to the SDK’s published grammar', () => {
  const source = scopeClauseTypeSource();

  /**
   * Letters the SDK's grammar names that this catalog deliberately does NOT
   * offer as a matrix column, and why. Anything outside this set appearing on
   * the SDK side is a real gap and must red.
   *
   * `s` (sensitive-field reveal) is correlated per record TYPE, so a grant is
   * only meaningful qualified — `records:rs:patient`. The matrix emits no
   * qualifiers, so a bare `s` checkbox would author a grant broader than any
   * admin ticking it intends. It is reachable through Advanced, which is where
   * the Advanced hint documents it.
   */
  const DELIBERATELY_UNOFFERED: ReadonlySet<string> = new Set(['s']);

  it('the op letters the SDK names are EXACTLY the ones this catalog offers, bar a declared exception', () => {
    const description = fieldDescription(source, 'allowed_actions');
    // The description names letters two ways: a slash-run (`c/r/u/d`) and
    // individually quoted (`'s'`, `'x'`). Three-letter minimum on the run,
    // matching the sibling guard: a 2-letter run also matches ordinary prose
    // like `w/o` and `n/a`, which would inject bogus letters — harmless under a
    // subset assertion, a spurious RED under this one.
    const named = new Set<string>();
    for (const run of description.matchAll(/\b(?:[a-z]\/){2,7}[a-z]\b/g)) {
      for (const ch of run[0].split('/')) named.add(ch);
    }
    for (const quoted of description.matchAll(/'([a-z])'/g)) named.add(quoted[1] as string);

    expect(named.size, 'parsed no op letters at all — the guard has gone blind').toBeGreaterThan(0);

    const authored = new Set(RESOURCE_CATALOG.flatMap((r) => [...r.ops]));

    // Direction 1 — a letter the catalog authors that the SDK does not name.
    // A typo, or a letter retired from the grammar; either way the matrix
    // offers a checkbox authoring something the platform will not honour.
    const unnamed = [...authored].filter((l) => !named.has(l)).sort();
    expect(
      unnamed,
      `this catalog offers op letter(s) [${unnamed}] that the SDK's grammar does not name`,
    ).toEqual([]);

    // Direction 2 — THE ONE THAT MATTERS, and the one a subset test cannot see.
    // A letter the SDK names that no catalog resource offers is a grammar the
    // app has fallen behind: exactly the state this branch found it in, where
    // `x` had shipped in the API and the matrix still described four letters.
    const unoffered = [...named].filter((l) => !authored.has(l) && !DELIBERATELY_UNOFFERED.has(l)).sort();
    expect(
      unoffered,
      `the SDK's grammar names op letter(s) [${unoffered}] that no catalog resource offers. ` +
        'Either add the letter to the resources it applies to, or — if it is deliberately not ' +
        'offered as a column — add it to DELIBERATELY_UNOFFERED with the reason, so the next ' +
        'letter still reds instead of hiding behind this one.',
    ).toEqual([]);

    // And the matrix's own columns cannot exceed what the catalog can author.
    for (const { letter } of CRUD_OPS) {
      expect(authored.has(letter), `matrix column "${letter}" is on no catalog resource`).toBe(true);
    }
  });

  it('the SDK being read is the build this app pins — otherwise every assertion above compares the wrong side', () => {
    // An older hoisted install names fewer letters and therefore agrees with any
    // mirror, including a drifted one. A guard that can be satisfied by a stale
    // node_modules is not a guard; make the mismatch loud instead.
    const sdkEntry = createRequire(import.meta.url).resolve('@vectros-ai/sdk');
    const installed = JSON.parse(
      readFileSync(join(dirname(dirname(sdkEntry)), 'package.json'), 'utf8'),
    ) as { version?: string };
    const manifest = JSON.parse(
      readFileSync(createRequire(import.meta.url).resolve('../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(
      installed.version,
      'the resolved @vectros-ai/sdk is not the build this app declares, so the comparison ' +
        'above is being made against the wrong side — reinstall before trusting a green here',
    ).toBe(manifest.dependencies?.['@vectros-ai/sdk']);
  });

  it('the SDK still declares assignable_roles — the field every save path here carries through', () => {
    // If a future SDK drops or renames this, the carry-through becomes a silent
    // no-op: the value would be typed away and never reach the wire, with every
    // unit test in this repo still green because they all stop at the helper.
    expect(source).toMatch(/\bassignable_roles\s*\??\s*:/);
  });

  it('the SDK still describes the qualifier axes this app’s Advanced hint teaches', () => {
    const description = fieldDescription(source, 'allowed_actions');
    // The hint tells an admin which resources take a qualifier and on which
    // letters. These are the load-bearing claims in it; if the published
    // grammar stops making them, the hint is asserting something unsourced.
    expect(description).toMatch(/scripts/);
    expect(description).toMatch(/documents/);
    expect(description).toMatch(/profiles/);
  });
});
