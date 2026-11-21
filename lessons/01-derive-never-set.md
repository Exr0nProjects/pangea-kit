# Derive, never set

**What happened.** After a reload, the checkboxes in a 3D viewer's side panel were correct but the scene still showed layers that were unchecked. Two copies of one fact existed: the panel's state and the mesh's own `visible` flag. Restore code set the first and nothing re-applied it to the second.

**Lesson.** The picture is a function of state. Create an object, then immediately declare how each of its properties derives from state (`sync(obj, { visible: () => state.layer.visible })`); handlers dispatch an absolute value ("layer is hidden") and never touch the object. Then reload, undo, replay and a second tab all agree for free.

**Smell.** A handler that sets a property directly; initial values written once from literals; a "refresh" function.

Fed: R9, P2, P14.
