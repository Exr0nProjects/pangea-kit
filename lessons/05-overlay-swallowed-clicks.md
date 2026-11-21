# The overlay that swallowed every click

**What happened.** Buttons and sliders in a new applet did nothing. The host puts a full-screen UI layer over the canvas with `pointer-events: none` so empty space can still orbit the camera. CSS `pointer-events` is inherited, so every control mounted into that layer without opting back in was dead, and clicks fell through to the canvas. It had been hit repeatedly; only the kit's own panel component opted in.

**Lesson.** Fix the class, not the instance. The host now opts each mounted part back in (`pointer-events: auto` on the part's wrapper, which has no box of its own, so empty space still passes through), and the publish gate loads the page and fails any visible control whose centre point is covered by the canvas. A new applet cannot reintroduce the bug without the build refusing.

**Also noisy but harmless.** An analytics-beacon CSP block and a speculation-rules CORS error in the console were reported as the cause. They were unrelated; keep a known-noise allowlist so real errors stand out.

Fed: P29, P12. Harness C2 and C3.
