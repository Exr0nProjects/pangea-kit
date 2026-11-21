<script>
  // Toggle as a button showing its label; highlighted when on. bind:on.
  let { label = '', on = $bindable(false), title = '' } = $props()
</script>
<button type="button" {title} aria-pressed={on} class:on onclick={() => (on = !on)}>{label}</button>
<style>
  button { background: var(--ctl, #eee); color: var(--fg, inherit); border: 1px solid var(--ctlb, #8886); padding: 2px 8px; font: inherit; cursor: pointer; border-radius: 3px }
  button.on { background: var(--accent, #2a7); color: var(--accent-fg, #fff); border-color: var(--accent, #2a7) }
</style>
