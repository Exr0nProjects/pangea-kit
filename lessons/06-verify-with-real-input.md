# Verify with real input, not el.click()

**What happened.** Calling `element.click()` in the page console reported a working button while a real mouse click did nothing, because something covered the button. A second slip: counting buttons by index silently included the panel's collapse header, and matching by text hit "undamped" when asked for "damped".

**Lesson.** A check must use the same path a user does: hit-tested mouse events at the element's centre (and `mouseMoved` first), keyboard events for slider drags, a background tab paused or an unfocused tab throttling animation frames (activate it before measuring). List the button texts before choosing an index, and remember a substring match is a substring match. Clicking a panel header collapses the panel, so click header-like buttons last.

**Report honestly.** Pixels counted is not pixels looked at; say which.

Fed: P32, R11. See `harness/check-live.mjs`.
