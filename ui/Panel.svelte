<script>
  // A floating control panel. `pos` picks the corner; collapsible; scrolls when taller than the window.
  let { title = '', pos = 'left', children, open = $bindable(true) } = $props()
</script>
<div class="qk-panel {pos}">
  <button class="qk-h" onclick={() => (open = !open)}><span>{title}</span><span class="qk-caret">{open ? '–' : '+'}</span></button>
  {#if open}<div class="qk-body">{@render children?.()}</div>{/if}
</div>
<style>
  .qk-panel { position: absolute; pointer-events: auto; top: 8px; width: 318px; max-height: calc(100vh - 16px); display: flex; flex-direction: column; background: #000d; color: #ddd; border: 1px solid #333; border-radius: 4px; font: 12px/1.5 ui-monospace, Menlo, monospace; z-index: 5; }
  .qk-panel.left { left: 8px } .qk-panel.right { right: 8px }
  .qk-h { all: unset; cursor: pointer; display: flex; justify-content: space-between; padding: 5px 10px; color: #fff; font-weight: 600; border-bottom: 1px solid #222; }
  .qk-body { overflow-y: auto; padding: 6px 10px 8px; }
</style>
