// UI laws: the owner's webchat corrections (webchat/tests/corrections/catalog.json) turned into laws any kit app gets by
// declaring state. checkUiLaws(decl, gen) runs every model-level law the declaration's contract turns on; the frame laws
// (frames.js) and the browser budget (budget.js checkBudgets) run where a page exists. See GUIDE section 3e.
import { uiContract, UI_DEFAULTS, LAW_CLASSES } from './contract.js';
import { checkBudgets, reducerBudget, percentile } from './budget.js';
import { checkReloadRestores, checkFirstPaint, checkNoLoss, checkIdempotentRetryAndConverge, checkNoLossTrace, checkLiveness, checkBoundedWork, memStorage, flakyTransport } from './trace.js';
import { checkMotion, checkSettled, checkLayoutStable, checkAnchorStable, checkFlicker, motionWindow, recordFrames, measureInteraction } from './frames.js';
import { fuzz, declExec } from './fuzz.js';
import { declare } from '../model.js';

export { uiContract, UI_DEFAULTS, LAW_CLASSES, checkBudgets, reducerBudget, percentile, checkReloadRestores, checkFirstPaint, checkNoLoss,
  checkIdempotentRetryAndConverge, checkNoLossTrace, checkLiveness, checkBoundedWork, memStorage, flakyTransport, checkMotion, checkSettled,
  checkLayoutStable, checkAnchorStable, checkFlicker, motionWindow, recordFrames, measureInteraction, fuzz, declExec };

/** Every model-level law the declaration turns on. `spec` may be a declare() result or the raw spec. Returns
 *  { contract, failures: [{ law, ... }] }; an empty failures list is a pass. Cost: about a second per declaration. */
export async function checkUiLaws(spec, gen, { seeds = 40, length = 24, timing = true } = {}) {
  const decl = spec.step ? spec : (Object.isFrozen(spec) ? spec : declare(spec));
  const contract = uiContract(decl);
  const L = contract.laws;
  const failures = [];
  if (L.reloadRestores) failures.push(...checkReloadRestores(decl, gen, { seeds, length }));
  if (L.firstPaint) failures.push(...checkFirstPaint(decl, gen, { seeds, length }));
  if (L.noLoss) failures.push(...checkNoLoss(decl, gen, { seeds, length }));
  if (L.tabsConverge) failures.push(...await checkIdempotentRetryAndConverge(decl, gen, { seeds: Math.min(seeds, 30), length }));
  if (timing && L.reducerBudget) failures.push(...reducerBudget(decl, gen));
  return { contract, failures };
}
