# Verification harness

The checklist an applet passes before anyone is told it works. A green build is not enough: nearly every defect so far lived in a transition (reload, republish, drag, mode change), not in a static state. Each check names the failure it exists to catch (a PITFALL or RULE id from `../SKILL.md`) and whether it is automated.

Run what exists: `node harness/check-live.mjs <page-url> --cdp http://localhost:9222` (a Chrome started with `--remote-debugging-port`; Node 22+; no dependencies). Exit code 0 only if everything passes.

| id | check | catches | status |
| --- | --- | --- | --- |
| C1 | page loads clean: status chip reads `● live`, canvas present, no red part error line | P23, P28, P30 | automated (`check-live.mjs`) |
| C2 | no dead controls: every visible control is the topmost element at its centre | P29 | automated |
| C3 | real mouse events reach controls: at least one button changes saved state | P29 | automated |
| C4 | live drag keeps the clock running: after keyboard-driving a slider, the visible clock rose and state changed | R7 | automated |
| C5 | controls applicable: after each mode or step change, the set of visible controls equals the designed set | R6 | todo: needs a per-app manifest of `mode -> visible control labels` |
| C6 | instruction coverage: every imperative sentence in the page text has a control whose label names the action | R8 | todo: text scan plus label match, per step |
| C7 | restart is the only reset: changing a slider never changes the run id or zeroes the clock or trace | R7, P31 | todo: extend C4 to read the state's run key |
| C8 | reload restores: mode and slider values survive a reload and the chip reads `● live` | P1, P20 | todo |
| C9 | hot swap: republish into the same URL; the page is not reloaded (same canvas element), only changed part files are fetched, selection and camera unchanged | P1, P3 | todo |
| C10 | cold start: a fresh tab with no saved state renders from defaults without an abort message | P20 | todo |
| C11 | pixels: a screenshot is not blank (non-background fraction above a floor) and the fraction moves when the main layer is toggled | P23 | todo: screenshot plus image diff |
| C12 | visual regression: per mode and per step, screenshot compared to an approved baseline within a tolerance, light and dark scheme | R10, R11 | todo |
| C13 | theme: with the system scheme forced dark then light, canvas and text stay readable and no hard-coded colours leak | R10 | todo: emulate `prefers-color-scheme` |
| C14 | viewport sweep: 1280x800, 730x410 and a phone width; panel scrolls inside itself, no control clipped off-screen | P29 | todo |
| C15 | console: no errors except the known noise allowlist (analytics beacon CSP block, speculation-rules CORS) | P12 | todo |
| C16 | sandbox: no request to an external origin, no storage access error | P12 | todo |
| C17 | performance: frame time p95 under budget during a slider drag; no long task over 100 ms | R7 | todo: trace via the performance domain |
| C18 | determinism: with a fixed seed and clock, two runs produce the same state trace | R9 | todo |
| C19 | keyboard: documented keys act and browser shortcuts are not overridden | R10 | todo |
| C20 | 3D only: click selects, empty click does not clear unexpectedly, the scale bar matches a known distance | P21, P27 | todo |
| C21 | page text: no em dashes, symbols defined at first use, toy numbers labelled | R13 | todo: lint over the rendered text |
| C22 | cleanup: scratch artifacts removed, probe app directories deleted, only the app's own paths committed | P8, P15 | todo |

Design notes for the heavy version: a check is a function from a live page to pass/fail plus a one-line reason; checks are independent so one failure does not hide another; every automated check ships with a deliberately broken fixture applet that it must fail on (the dead-control fixture is an app whose panel inherits `pointer-events:none`); results are printed one line per check so an agent can paste them into its report.
