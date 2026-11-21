<script>
  // Marks the view of one or more derivations: the kit dims it slightly (opacity 0.85, input never blocked) while any of
  // them is in flight. Pure CSS from the `data-derived` attribute (lib/derived-dom.js), so it works while the main thread is
  // frozen by a synchronous compute. `of` is a derivation name or an array of names; any element can do the same by hand:
  // <div data-derived="scene">.
  let { of, style = '', children } = $props()
  const names = $derived((Array.isArray(of) ? of : [of]).filter(Boolean).join(' '))
</script>

<div class="qk-pending" data-derived={names} {style}>{@render children?.()}</div>
