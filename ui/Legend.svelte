<script>
  // items: [{ id, label, color, count?, on }]; each row toggles item.on (bind through the state path or handle `ontoggle`).
  let { items = [], ontoggle } = $props()
</script>
<div>
  {#each items as it (it.id)}
    <label class="qk-lg"><input type="checkbox" checked={it.on} onchange={(e) => ontoggle?.(it.id, e.currentTarget.checked)} /><span style="color:{it.color}">■</span><span>{it.label}</span>{#if it.count != null}<span class="qk-n">{it.count}</span>{/if}</label>
  {/each}
</div>
<style>
  .qk-lg { display: flex; align-items: center; gap: 5px; margin: 1px 0; cursor: pointer } .qk-n { color: #777; margin-left: auto }
  input { accent-color: #7fb0ff; margin: 0 }
</style>
