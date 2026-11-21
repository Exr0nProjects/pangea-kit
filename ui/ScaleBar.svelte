<script>
  // Scale bar overlay for an image. Put inside a position:relative wrapper. mmPerPx = physical pixel size, zoom = css px per image px.
  let { mmPerPx = 0, zoom = 1 } = $props()
  const NICE = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]
  const mm = $derived.by(() => { if (!mmPerPx) return 0; let best = NICE[0]; for (const n of NICE) if (n / mmPerPx * zoom <= 140) best = n; return best })
  const px = $derived(mm ? mm / mmPerPx * zoom : 0)
</script>
{#if mm}
  <div style="position:absolute;left:8px;bottom:8px;pointer-events:none;color:#fff;font:11px ui-monospace,monospace;text-shadow:0 0 3px #000,0 0 3px #000">
    <div style="width:{px}px;height:0;border-top:3px solid #fff;box-shadow:0 0 3px #000"></div>{mm} mm
  </div>
{/if}
