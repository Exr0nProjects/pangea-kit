Build a kit applet: `apps/<name>`, published to one viewer URL (use `--into <ULID>` if this extends an existing tool; no new host).

1. Load SKILL.md first and do not read other docs unless it says to. Copy the template that fits (2D or 3D).
2. Goal in one sentence: <what the user wants to see or do, and what decision it supports>. Data: <inputs, units, scale; which numbers are measured, which are toy or unsourced>.
3. Before coding, list every control and the modes or steps where it changes the picture (R6), which quantities are integrated and which are pure functions of controls (R7), and which on-screen instructions need a control (R8).
4. State first: `state.js` holds every control and scene property; the picture is derived from state; handlers write absolute values only.
5. Plain, classy, monospace; theme variables only; no external fetches, fonts or scripts.
6. Verify in real Chrome with the harness (`harness/check-live.mjs` plus the manual steps in SKILL.md section 5). Include the screenshot and say whether pixels were counted or looked at.
7. Reply short: the URL, three bullets of what to click or drag, what is unsourced, what you could not verify. No build story.
8. If anything in the kit blocked you, fix the kit or SKILL.md with a test or a new row, not around it.
