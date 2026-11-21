// meta.json for an artifact, derived from quicklook.json (kept free of node/esbuild imports so tests can load it).
/** meta.json content from quicklook.json: title always; axes only when false; units / unitScale only when valid. */
// Connect allowlist: exact origins only (https://host[:port] or wss://host[:port]); no wildcards, paths or schemes alone. Plain http/ws
// only for loopback (http://localhost[:port], http://127.0.0.1[:port]): browsers treat loopback as a secure context, so an https page may
// reach a local forwarder; any other http/ws is mixed content and refused. The webchat host validates again with the same rule
// (webchat/src/lib/server/file-response.js connectOriginsFrom) before it puts anything in the CSP.
const CONNECT_ORIGIN = /^(?:(?:https|wss):\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|(?:http|ws):\/\/(?:localhost|127\.0\.0\.1))(?::\d{1,5})?$/u
export function cleanConnect(list) {
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error('quicklook.json "connect" must be an array of origins like "https://compute.example.com"')
  const out = []
  for (const raw of list) {
    const o = String(raw).trim().toLowerCase()
    if (!CONNECT_ORIGIN.test(o)) throw new Error(`quicklook.json "connect": ${JSON.stringify(raw)} is not an exact https:// or wss:// origin (no wildcards, paths or spaces)`)
    if (!out.includes(o)) out.push(o)
  }
  return out
}
export function metaFor(cfg, title) {
  const meta = { title }
  if (cfg.axes === false) meta.axes = false
  if (typeof cfg.units === 'string' && cfg.units.trim()) meta.units = cfg.units.trim()
  if (Number.isFinite(cfg.unitScale) && cfg.unitScale > 0) meta.unitScale = cfg.unitScale
  const connect = cleanConnect(cfg.connect)
  if (connect.length) meta.connect = connect
  return meta
}
