# pangea-kit skill

Start with [SKILL.md](SKILL.md). It is one file an agent can load into context and use to write, publish and verify a small interactive applet (a canvas explainer, calculator or 3D viewer) in one shot. It holds the workflow, copy-paste templates, a numbered RULES list (what an applet must do) and a numbered PITFALLS list (how builds broke).

This repository holds the skill and what grows around it. It does not contain the kit runtime itself (the host, state core and UI components that `SKILL.md` calls `pangea-kit`).

| folder | what it is |
| --- | --- |
| `SKILL.md` | the landing file: decision tree, templates, publish and verify steps, RULES, PITFALLS |
| `harness/` | the verification checklist as numbered checks, plus `check-live.mjs`, a dependency-free live check (loads clean, no dead controls, live drag does not reset, real clicks reach controls) |
| `prompts/` | the one-shot prompt template and example asks |
| `examples/` | small applets that follow the templates: a 2D damped oscillator, a 2D projected Bloch-sphere explainer, a minimal 3D scene |
| `lessons/` | short, generic write-ups of what went wrong building applets and what fixed it |

To add a rule or pitfall, edit the tables in `SKILL.md` (header explains the format), keep one line each, and upgrade `none` in the "checked by" column to a harness check when a rule recurs.
