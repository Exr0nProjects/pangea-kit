# Controls only where they apply

**What happened.** A step-by-step explainer showed a "detuning" slider in every step, including steps where detuning has no meaning. The owner: a control on something it doesn't apply to "just confused me". A related bug: a hidden control's stale value could still move the picture.

**Lesson.** Before writing the component, tabulate each control against the modes or steps where it changes the picture. Show it only there (or disable it with the reason beside it). The drawing must read the control through the same condition that shows it, so a hidden value cannot act. A step function sets that step's defaults.

**Smell.** One shared control panel for a multi-step story; a readout that is meaningful in only one mode.

Fed: R6, P31. Harness C5 (todo) needs a per-app manifest of mode to visible controls.
