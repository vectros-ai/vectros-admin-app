// ---------------------------------------------------------------------------
// messages.icu — every catalog entry must parse as valid ICU MessageFormat.
//
// react-intl's default runtime behavior on a malformed message is NOT to
// throw: it console.errors and falls back to rendering the raw message id.
// Every existing unit test render therefore passes even when a message is
// broken — this class of bug shipped once (a literal `${{ ... }}` in
// scopeEditor.dataScopeHelp, whose curly braces ICU parses as an argument
// placeholder, and a pre-existing `<suffix>`-shaped placeholder that ICU's
// parser reads as an unclosed rich-text tag) and was only caught by a live
// Playwright smoke run reading the browser console — expensive, slow
// feedback for a defect a parse-only check catches in milliseconds.
//
// This sweeps the REAL merged catalog (`MESSAGES_BY_LOCALE`, the same object
// <IntlProvider> hands to react-intl) rather than re-deriving the merge here,
// so it can never drift from what production actually renders.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';

import { MESSAGES_BY_LOCALE } from './IntlProvider';

describe('every catalog message parses as valid ICU MessageFormat', () => {
  for (const [locale, messages] of Object.entries(MESSAGES_BY_LOCALE)) {
    describe(`locale: ${locale}`, () => {
      const entries = Object.entries(messages);

      it('has at least one message (the sweep below would vacuously pass on an empty catalog)', () => {
        expect(entries.length).toBeGreaterThan(0);
      });

      for (const [id, message] of entries) {
        it(`"${id}" parses`, () => {
          expect(() => new IntlMessageFormat(message, locale)).not.toThrow();
        });
      }
    });
  }
});
