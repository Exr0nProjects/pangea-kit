# pangea-kit skill

Start with [SKILL.md](SKILL.md). It is one file an agent can load into context and use to write, publish and verify a small interactive applet (a canvas explainer, calculator or 3D viewer) in one shot. It holds the workflow, copy-paste templates, a numbered RULES list (what an applet must do) and a numbered PITFALLS list (how builds broke).

This repository is the kit: the runtime (host, state core, UI components, CLI, lint, tests) and the skill that goes with it.

```
npm ci && npm test
node bin/pangea-kit.mjs publish examples/damped-oscillator --local   # prints http://127.0.0.1:4180/view/<ULID>/
```

`--local` is also the default when no hosted publisher is configured. It serves the page from a dependency-free loopback viewer (`lib/local-viewer.mjs`) with the sandbox CSP a hosted viewer uses. Node 22+; Chrome for the boot gate and the live harness.

| folder | what it is |
| --- | --- |
| `lib/` `host/` `ui/` `bin/` `lint/` | the runtime: state core, host page, UI components, publish CLI, local viewer, lint |
| `tests/` `conformance/` | the kit's own test suite and conformance vectors (`npm test`) |
| `GUIDE.md` `docs/` | the API reference and the older recipe and lint notes (optional reading: `SKILL.md` is enough to build an applet) |
| `SKILL.md` | the landing file: decision tree, templates, publish and verify steps, RULES, PITFALLS |
| `harness/` | the verification checklist as numbered checks, plus `check-live.mjs`, a dependency-free live check (loads clean, no dead controls, live drag does not reset, real clicks reach controls) |
| `prompts/` | the one-shot prompt template and example asks |
| `examples/`, `apps/` | small applets that follow the templates (`apps/` holds two more used by the tests): a 2D damped oscillator, a 2D projected Bloch-sphere explainer, a minimal 3D scene |
| `lessons/` | short, generic write-ups of what went wrong building applets and what fixed it |

To add a rule or pitfall, edit the tables in `SKILL.md` (header explains the format), keep one line each, and upgrade `none` in the "checked by" column to a harness check when a rule recurs.
