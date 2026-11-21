// The state schema: the ONLY place state is declared. version + upcasters follow viewer5's persist contract;
// new keys added to `initial` appear in an open page without resetting anything else.
export default {
  name: 'example',
  version: 1,
  initial: {
    camera: null,                        // viewer reconciles the camera from this (null = default view)
    cube: { opacity: 0.8, visible: true },
    sel: { ids: [], picks: [] },
    _info: '',                           // _ keys are transient: never persisted
  },
  migrations: {},
  setup(store, { selection }) { store.component('sel', selection()) },
}
