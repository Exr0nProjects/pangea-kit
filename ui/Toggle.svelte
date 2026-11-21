<script>
  let { label = '', checked = $bindable(false), color = null, note = '' } = $props()
</script>
<label class="qk-t"><input type="checkbox" bind:checked />{#if color}<span style="color:{color}">■</span>{/if}<span>{label}</span>{#if note}<span class="qk-n">{note}</span>{/if}</label>
<style>
  .qk-t { display: flex; align-items: center; gap: 5px; margin: 1px 0; cursor: pointer }
  .qk-n { color: #777; margin-left: auto }
  input { accent-color: #7fb0ff; margin: 0 }
</style>
