<script>
  // The kit's 2D image panel: draws `src` (url, data: or blob: URL) or paints into a canvas you get through
  // `oncanvas`, with the scale bar and x/y extent labels built in. The app passes its pixel size:
  //   <ImagePlane src={url} width={512} height={512} pixelSize={4} />        (pixelSize: µm per source pixel)
  // `width` x `height` are the SOURCE pixel size; `shown` is the on-screen width in CSS px (default: fit 100%).
  import ScaleBar from './ScaleBar.svelte'
  import { formatNumber, pickUnits } from '../lib/scale.js'
  let { src = '', width = 1, height = 1, pixelSize = 1, pixelSizeY = null, shown = 320, units = null, oncanvas = null, alt = '', pixelated = true, children } = $props()
  const u = $derived(pickUnits({ units }, globalThis.__pangea?.kit?.units))
  const zoom = $derived(shown / width)
  const ex = $derived(width * pixelSize * u.scale), ey = $derived(height * (pixelSizeY ?? pixelSize) * u.scale)
  let canvas = $state(null)
  $effect(() => { if (canvas && oncanvas) oncanvas(canvas) })
</script>
<div class="qk-ip" data-qk="imageplane" data-extent-x={ex} data-extent-y={ey} data-unit={u.unit}>
  <div class="qk-ip-row">
    <div class="qk-ip-y"><span>0</span><span class="qk-ip-u">y {u.unit}</span><span>{formatNumber(ey)}</span></div>
    <div class="qk-ip-img" style="width:{shown}px;height:{shown * height / width}px">
      {#if src}<img {src} {alt} style="width:100%;height:100%;image-rendering:{pixelated ? 'pixelated' : 'auto'}" />{:else}<canvas bind:this={canvas} {width} {height} style="width:100%;height:100%;image-rendering:{pixelated ? 'pixelated' : 'auto'}"></canvas>{/if}
      <div class="qk-ip-sb"><ScaleBar {pixelSize} {zoom} {units} /></div>
      {@render children?.()}
    </div>
  </div>
  <div class="qk-ip-x" style="margin-left:34px;width:{shown}px"><span>0</span><span class="qk-ip-u">x {u.unit}</span><span>{formatNumber(ex)}</span></div>
</div>
<style>
  .qk-ip { display: inline-block; font: 11px/14px ui-monospace, Menlo, monospace; color: #9a9a9a }
  .qk-ip-row { display: flex; gap: 4px }
  .qk-ip-y { width: 30px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; text-align: right }
  .qk-ip-x { display: flex; justify-content: space-between }
  .qk-ip-u { color: #777 }
  .qk-ip-img { position: relative; background: #000; outline: 1px solid #333 }
  .qk-ip-sb { position: absolute; left: 8px; bottom: 6px }
</style>
