// Every registered component kind carries its law generator and its committed conformance vectors, and keeps every law.
// A kind added to lib/components.js `registry` without a gen in conformance/gens.js is never law-checked (the laws test
// loops over gens, not over the registry), which is the gap this closes. Pure: the caller passes the pieces.
//   checkKinds({ registry, gens, vectorKinds, checkLaws, seeds }) -> [] or ['kind: problem', ...]
export function checkKinds({ registry, gens, vectorKinds, checkLaws, seeds = 50 }) {
  const problems = [];
  const vk = new Set(vectorKinds);
  for (const kind of Object.keys(registry)) {
    if (!gens[kind]) problems.push(`${kind}: registered with no law generator in conformance/gens.js`);
    if (!vk.has(kind)) problems.push(`${kind}: registered with no conformance/components/${kind}.json vectors`);
    if (gens[kind] && checkLaws) {
      const bad = checkLaws(registry[kind](...(gens[kind].args || [])), gens[kind].gen, { seeds });
      if (bad.length) problems.push(`${kind}: breaks law ${bad[0].law} (seed ${bad[0].seed}: ${bad[0].detail})`);
    }
  }
  for (const kind of Object.keys(gens)) if (!registry[kind]) problems.push(`${kind}: generator for an unregistered kind`);
  for (const kind of vk) if (!registry[kind]) problems.push(`${kind}: vectors for an unregistered kind`);
  return problems;
}
