# Example asks

**Mechanism explainer (2D, steps).** "Show me each step of how an RF pulse tips magnetization, in the lab frame and the rotating frame, with a control for the pulse and a detuning slider only where detuning matters." Result: `examples/nmr-rotating-frame`. Rules it exercises: a step selector that sets the whole state (R6), live-drag integration (R7), a toggle for the pulse the caption tells you to stop (R8).

**Calculator with a plot (2D).** "A mass on a spring with an undamped mode and a damped mode; damping only shows up in damped mode; dragging a slider should bend the motion, not restart it." Result: `examples/damped-oscillator`.

**Spatial viewer (3D).** "Five bars I can click, shift-click, hide, and fade; selection must survive a reload." Result: `examples/minimal-3d-scene`. Rules: derive the scene from state (R9), opaque at full opacity (P5).

**Tweak request (iterate).** "The slider resets the animation when I drag it" or "I can't click anything". These are rule or pitfall hits (R7, P29): find the row in SKILL.md, fix the app, and if the failure is structural fix the kit and add a check.
