# Viewers: traceable, derived, light on data

Lessons from a layered volumetric viewer (vessel meshes plus electron-microscopy slices); the data is not included here.

- **Real shapes, units.** Meshes with true diameters, units in the panel; not point clouds or static plots.
- **Traceable.** A tangle of meshes is unusable until one structure can be followed: translucent context layer, opaque highlighted selection, grow, isolate, hide, clear, measure.
- **Opaque at full opacity.** A slider that tops out still see-through meant the material stayed transparent and depth-write off. At opacity near 1 switch transparency off and depth-write on; context layer drawn after, selection before.
- **Image contrast.** Raw microscopy slices look like mud. Provide brightness, contrast, gamma and invert from the start through a 256-entry lookup table, default contrast above 1, per-axis slice slider, and say where data does not exist.
- **Data.** One file per concern, each with its own content hash, so changing one thing re-downloads one file; never inline big arrays into state or a part; decode once and memoize across hot swaps. A published copy of data is a snapshot: label "as of" if the source keeps changing.
- **Camera.** The default camera looks at the origin from far away; recentre data or fit the camera after first load.

Fed: R12, P3, P5, P6, P7, P11, P22.
