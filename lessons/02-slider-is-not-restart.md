# A slider is not a restart

**What happened.** An animated explainer was keyed on its parameters: any slider change rebuilt the simulation, so dragging made the animation "glitch-reset" instead of bending smoothly. The owner wanted to watch the effect change in real time while dragging.

**Lesson.** Separate three kinds of quantity. Controls live in saved state and are only written by handlers. Integrated quantities (clock, angle, position, trail) are plain local variables advanced by the frame step `dt` from the current controls (`phase += w * dt`, never `phase = w * t`, which jumps when `w` changes). Pure functions of controls (a curve, a spectrum) are recomputed from state each frame. Only a deliberate event (restart button, mode or step change, page load) bumps a run id that resets the integrated locals. The animation loop's effect must read no reactive state synchronously, or the framework re-runs it on every change and restarts the loop.

**Check.** Print the clock in the panel. Drag a slider by keyboard; the clock must keep rising.

Fed: R7, P31. Automated as harness C4.
