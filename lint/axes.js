// Declared means enforced (PANGEA3-DESIGN A10: "An axis, guard, undo declaration or retention policy that nothing reads
// is removed or made to fail validation"). The one table is lib/declare-keys.js: `declare` refuses every key outside it
// at run time; this module is the same table for the static `unenforced-axis` lint rule (an earlier, cheaper signal).
// tests/lint.test.js proves each ENFORCED key is actually read in lib/ (a key cannot be listed on faith).
import { DECLARE_KEYS, NOT_EXECUTED } from '../lib/declare-keys.js';

export const ENFORCED = Object.keys(DECLARE_KEYS);
export const UNENFORCED_AXES = Object.keys(NOT_EXECUTED);

/** Keys of a declaration spec that the engine does not enforce (unknown or not-yet-enforced axes). */
export function unenforcedKeys(spec) {
  return Object.keys(spec || {}).filter((k) => !ENFORCED.includes(k));
}
