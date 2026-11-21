# Why one skill file

**What happened.** Building the same small applet took far more effort with the kit than with raw HTML, because the kit's rules lived in a roughly 95 KB guide, a recipe, a design document, a pitfalls list and several example apps. Raw HTML needs none of that reading.

**Lesson.** The bar is "easier, not harder, than native code". If an agent needs more than one file loaded into context to get an applet right in one shot, the gap is a documentation bug. Keep one landing file: decision tree, copy-paste templates, exact commands, a verify checklist as commands, and the rules and pitfalls as one-line rows with id, date, source quote, fix and what enforces it. Test it cold: generate a fresh applet from that file alone and count the extra documents opened (target 0); fix the file for every gap.

**How to iterate.** Every owner correction becomes a row. A rule that recurs with no enforcement is a missing check: build the check, change the column.

Fed: R2, R16.
