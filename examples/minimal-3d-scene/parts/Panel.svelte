<script>
  import { Panel, Slider, Toggle, Button } from 'pangea-kit/ui'
  let { state, dispatch } = $props()
</script>
<Panel title="example v2">
  <Slider label="cube opacity" bind:value={state.cube.opacity} min={0} max={1} step={0.01} />
  <Toggle label="cube visible [h]" bind:checked={state.cube.visible} />
  <Button label="clear" hint="c" onclick={() => dispatch('sel/clear', {}, { undoable: true })} />
  <div style="color:#7fb0ff;min-height:1.5em">{state._info} · selected {state.sel.ids.length}</div>
</Panel>
