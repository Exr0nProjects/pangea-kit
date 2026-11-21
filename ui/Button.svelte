<script>
  let { label = '', hint = '', active = false, disabled = false, onclick } = $props()
</script>
<button class:active {disabled} {onclick}>{label}{#if hint} <span class="qk-k">[{hint}]</span>{/if}</button>
<style>
  button { font: inherit; background: #1c1c1c; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px 7px; margin: 1px; cursor: pointer }
  button:hover:not(:disabled) { border-color: #7fb0ff } button.active { background: #3a3a1c; border-color: #cc6 } button:disabled { opacity: .4; cursor: default }
  .qk-k { color: #888 }
</style>
