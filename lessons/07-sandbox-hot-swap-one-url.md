# The sandbox, the hot swap and the one URL

**Sandbox.** Published pages run in a locked-down frame: no external scripts, fonts, images or fetches, no storage, no service worker. Everything the page needs is baked into the part or a data file at publish time. A full reload re-downloads heavy data and nothing in the page can cache it; keep data lean (quantized) and never promise instant reloads.

**Hot swap.** Republishing into the same URL swaps only changed parts and data files without reloading, and keeps state. A viewer that reloaded on every code change, flashed black and re-applied an old pushed state over the user's view was the original complaint; the fixes were part-level hot swap, push messages with ids that a page applies once, and tolerating a null camera. Update with `--into`; push only the leaves you mean to change.

**One URL.** A first tool got its own hostname, tunnel and background jobs; the owner called it overbuilt. Every tool lives at one URL form and a changed tool reuses its identifier.

Fed: P1, P3, P4, P7, P8, P12, P25, R4, R14.
