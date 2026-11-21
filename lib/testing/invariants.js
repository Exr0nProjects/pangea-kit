// Model-check runner (pangea-ui-kit testing, GUIDE section 7): named invariants over traces.
//
// An invariant is a pure function trace -> violations ([{ step, evidence }], empty when it holds). The six
// standard factories below cover what every kit app with an outbox, a log and tabs must keep; an app
// instantiates them with a few accessors over ITS trace and adds its own with `invariant(fn)`.
//
//   noLoss            every accepted intent is durable, or visibly failed, at the finale
//   idempotentRetry   no intent is durable more than once (retries, lost replies, replays, two tabs)
//   replayStable      a step that re-delivers what was already delivered changes nothing visible
//   tabsConverge      replicas showing the same thing agree once quiet
//   reloadRestores    a reload restores the visible state it interrupted
//   deadlineBound     a measured latency stays under its deadline (hung request vs UI, telemetry vs send)
//
// Steps whose settle hit its deadline are skipped by the before/after invariants: a state still moving
// cannot be compared, and the differential already reports how often that happens.

import { canonicalizer } from './trace.js';

export const invariant = (fn, doc = '') => Object.assign((trace) => fn(trace) || [], { doc });

const stepBefore = (trace, i) => (i ? trace.steps[i - 1] : { obs: trace.initial?.obs, settle: trace.initial?.settle, tab: 0, meta: {} });
const same = (project, ids) => (a, b) => {
  const c = canonicalizer(ids);
  return JSON.stringify(c(project(a))) === JSON.stringify(c(project(b)));
};

/**
 * accepted(trace) -> [{ key, step }] (defaults to trace.accepted); durable(trace) -> [key...] with
 * multiplicity; failed(trace) -> [string...] visible failure texts (a key counts as failed when one
 * contains it).
 */
export function noLoss({ accepted = (t) => t.accepted, durable, failed = () => [] }) {
  return invariant((trace) => {
    const d = durable(trace) || []; const f = failed(trace) || [];
    return accepted(trace).filter((m) => !d.includes(m.key) && !f.some((x) => String(x).includes(m.key)))
      .map((m) => ({ step: m.step, evidence: `accepted ${JSON.stringify(m.key)} is neither durable nor shown as failed` }));
  }, 'every accepted intent is durable, or visibly failed, at the finale');
}

export function idempotentRetry({ keys = (t) => t.accepted.map((a) => a.key), durable }) {
  return invariant((trace) => {
    const d = durable(trace) || [];
    return [...new Set(keys(trace))].map((key) => [key, d.filter((x) => x === key).length]).filter(([, n]) => n > 1)
      .map(([key, n]) => ({ step: 'finale', evidence: `${JSON.stringify(key)} is durable ${n} times` }));
  }, 'no intent is durable more than once');
}

/** isReplay(stepRecord) picks the re-delivery steps; project(obs) is what must not change. */
export function replayStable({ isReplay, project, ids = [] }) {
  const eq = same(project, ids);
  return invariant((trace) => trace.steps.flatMap((s, i) => {
    if (!isReplay(s)) return [];
    const before = stepBefore(trace, i);
    if (!before.settle?.settled || !s.settle?.settled) return [];
    return eq(before.obs, s.obs) ? [] : [{ step: i, evidence: `${s.step.op} changed the visible state` }];
  }), 're-delivering what was delivered changes nothing visible');
}

/** pairs(trace) -> [[obsA, obsB], ...] that must agree under project. */
export function tabsConverge({ pairs = (t) => (t.finale?.converge ? [t.finale.converge] : []), project, ids = [] }) {
  const eq = same(project, ids);
  return invariant((trace) => pairs(trace).flatMap(([a, b], n) => (eq(a, b) ? [] : [{ step: 'finale', evidence: `replica pair ${n} disagrees` }])),
    'replicas showing the same thing agree once quiet');
}

/** isReload(stepRecord); skip(stepRecord) for reloads that are judged elsewhere (offline); project(obs). */
export function reloadRestores({ isReload, project, ids = [], skip = () => false }) {
  const eq = same(project, ids);
  return invariant((trace) => trace.steps.flatMap((s, i) => {
    if (!isReload(s) || skip(s)) return [];
    const before = stepBefore(trace, i);
    if ((before.tab ?? 0) !== (s.tab ?? 0) || !before.settle?.settled || !s.settle?.settled) return [];
    return eq(before.obs, s.obs) ? [] : [{ step: i, evidence: `${s.step.op} changed the visible state` }];
  }), 'a reload restores the visible state it interrupted');
}

/** measure(stepRecord) -> ms, null (never happened within the wait: a violation) or undefined (not measured). */
export function deadlineBound({ measure, deadlineMs, what = 'latency' }) {
  return invariant((trace) => trace.steps.flatMap((s, i) => {
    const ms = measure(s);
    if (ms === undefined) return [];
    return ms === null || ms > deadlineMs ? [{ step: i, evidence: `${what} ${ms === null ? 'never arrived' : `${ms}ms`} > ${deadlineMs}ms under ${JSON.stringify(s.meta?.fault ?? {})}` }] : [];
  }), `${what} stays under ${deadlineMs}ms`);
}

/** Run every named invariant on one trace: { name: violations[] }. A checker that throws is a violation. */
export function check(trace, invariants) {
  const out = {};
  for (const [name, fn] of Object.entries(invariants)) {
    try { out[name] = fn(trace); } catch (error) { out[name] = [{ step: '?', evidence: `checker threw: ${error.message}` }]; }
  }
  return out;
}

/** Totals over many checked traces: { name: { traces, violations } }. */
export function summarize(results) {
  const out = {};
  for (const r of results) for (const [name, v] of Object.entries(r)) {
    out[name] ||= { traces: 0, violatingTraces: 0, violations: 0 };
    out[name].traces += 1; out[name].violations += v.length; if (v.length) out[name].violatingTraces += 1;
  }
  return out;
}
