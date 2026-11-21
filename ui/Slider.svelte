<script>
  let { label = '', value = $bindable(0), min = 0, max = 1, step = 0.01, fmt = (v) => String(+(+v).toFixed(3)) } = $props()
</script>
<label class="qk-row"><span class="qk-l">{label}</span><input type="range" {min} {max} {step} bind:value /><span class="qk-v">{fmt(value)}</span></label>
<style>
  .qk-row { display: flex; align-items: center; gap: 6px; margin: 1px 0 }
  .qk-l { flex: 0 0 96px; color: #aaa } .qk-v { flex: 0 0 38px; text-align: right; color: #888 }
  input { flex: 1; min-width: 0; accent-color: #7fb0ff }
</style>
