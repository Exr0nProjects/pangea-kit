// Frame-law vectors: synthetic per-frame traces with the verdict each law must give. Each bad vector is the shape of a
// correction the owner made (cited by catalog id in webchat/tests/corrections/catalog.json). Regenerate:
//   node conformance/laws-ui/generate.mjs   (writes conformance/laws-ui/frames.json; no other input)
import { writeFileSync } from 'node:fs';

const F = 1000 / 60;
const easeOut = (u) => 1 - (1 - u) ** 3;
const track = (n, fn, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({ t: Math.round(i * F * 100) / 100, els: { card: fn(i / (n - 1)), ...extra(i / (n - 1), i) } }));
const at = (y, more = {}) => ({ x: 0, y: Math.round(y * 100) / 100, w: 100, h: 40, opacity: 1, visible: true, ...more });

const vectors = [
  { name: 'ease-out slide', law: 'motion', key: 'card', spec: { property: 'y' }, frames: track(15, (u) => at(200 * easeOut(u))), want: [] },
  { name: 'bounce on set-down', law: 'motion', key: 'card', spec: { property: 'y' }, cites: 'ec013b14#1230',
    frames: track(18, (u) => at(u < 0.8 ? 215 * easeOut(u / 0.8) : 215 - 15 * ((u - 0.8) / 0.2))), want: ['bounce'] },
  { name: 'two easings (fast set-down after the flip)', law: 'motion', key: 'card', spec: { property: 'y' }, cites: 'ec013b14#1230',
    frames: track(24, (u) => at(u < 0.5 ? 100 * easeOut(u / 0.5) : 100 + 100 * ((u - 0.5) / 0.5) ** 2)), want: ['speed peaks'] },
  { name: 'element vanishes mid-motion', law: 'motion', key: 'card', spec: { property: 'y' }, cites: 'ec013b14#647',
    frames: track(15, (u) => at(200 * easeOut(u), { opacity: u > 0.4 && u < 0.55 ? 0 : 1 })), want: ['vanished'] },
  { name: 'flap visible through the moving card', law: 'motion', key: 'card', spec: { property: 'y', hiddenDuring: ['flap'] }, cites: 'ec013b14#862',
    frames: track(15, (u) => at(200 * easeOut(u)), (u) => ({ flap: { x: 0, y: 0, w: 100, h: 30, opacity: u < 0.2 ? 1 : 0, visible: true } })), want: ['flap visible'] },
  { name: 'stutter (a 120 ms frame gap)', law: 'motion', key: 'card', spec: { property: 'y' },
    frames: track(15, (u) => at(200 * easeOut(u))).map((f, i) => (i >= 7 ? { ...f, t: f.t + 120 } : f)), want: ['stutter'] },
  { name: 'folders flash unfolded on reload, then snap', law: 'settled', project: 'open', cites: '66e9042d#4',
    frames: [0, 1, 2, 3, 4, 5].map((i) => ({ t: i * F, els: { a: { text: i < 3 ? 'open' : 'closed', visible: true, opacity: 1 }, b: { text: 'closed', visible: true, opacity: 1 } } })), want: ['settled'] },
  { name: 'first paint already settled', law: 'settled', project: 'open',
    frames: [0, 1, 2, 3].map((i) => ({ t: i * F, els: { a: { text: 'closed', visible: true, opacity: 1 }, b: { text: 'closed', visible: true, opacity: 1 } } })), want: [] },
  { name: 'row below shifts on hover', law: 'layoutStable', keys: ['below'], cites: '32bda034#2883',
    frames: [0, 1, 2].map((i) => ({ t: i * F, els: { below: at(i ? 24.3 : 3.2) } })), want: ['y'] },
  { name: 'mic icon toggles without a state change', law: 'flicker', key: 'mic', cites: '85e0379f#5',
    frames: [1, 0, 1, 0, 1].map((v, i) => ({ t: i * F, els: { mic: v ? at(0) : null } })), want: ['toggles'] },
];
writeFileSync(new URL('./frames.json', import.meta.url), JSON.stringify(vectors, null, 1) + '\n');
console.log(`${vectors.length} vectors`);
