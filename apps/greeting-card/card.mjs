// The GUIDE's greeting card on the hosted cloud: the whole app. Run twice to be two devices:
//   node apps/greeting-card/card.mjs /tmp/qk-issued2.json alice "happy birthday"
//   node apps/greeting-card/card.mjs /tmp/qk-issued2.json bob
// (token.json from POST https://issuer.example.invalid/api/pangea/token while signed in, or pangea-l1-deploy scripts/token.mjs)
import fs from 'node:fs';
import { declare } from '../../lib/model.js';
import { cloudApp } from '../../lib/cloud.js';
import { field, on } from '../../lib/schema.js';

const [tokenFile, device, msg] = process.argv.slice(2);
const { token } = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));

// A cloud device id must be as durable as its op log (a fresh store reusing a device id is a 409 at the worker),
// so this demo persists per device; a browser passes nothing and gets localStorage, which is already durable.
const file = `/tmp/qk-card-${device}.json`;
const mem = new Map(fs.existsSync(file) ? Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))) : []);
const save = () => fs.writeFileSync(file, JSON.stringify(Object.fromEntries(mem)));
const app = cloudApp({ token, secret: 'card-demo-key', device, storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); save(); }, removeItem: (k) => { mem.delete(k); save(); } } });

const card = app.use(declare({
  name: 'greeting-card', scope: 'cloud',
  fields: { to: field('', String), msg: field('', String), signed: field({}, (v) => v ?? {}) },
  actions: {
    'msg.set': on('msg', (_, { msg }) => msg),
    'sign': on('signed', (s, { by }) => (s[by] ? s : { ...s, [by]: true })),
  },
}));

if (msg) card.dispatch('msg.set', { msg });
card.dispatch('sign', { by: device });
await card.sync();
console.log(device, 'sees:', JSON.stringify(card.get()));
