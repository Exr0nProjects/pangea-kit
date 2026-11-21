// Undefined-identifier check for built app JS (publish runs it on every built part; lib/publish.mjs).
// Parses with acorn and resolves every identifier reference through real lexical scopes (module/function/block/catch/
// class/for/switch), so `ReferenceError: draft is not defined` (a Svelte part used `draft` outside the `$effect` that
// declared `const draft`; it only failed in the browser) is refused at publish time instead.
// Not references: property keys, non-computed member properties, labels, export names, import names of the source module.
// Shorthand properties ({ draft }) ARE references. let/const TDZ is not modelled (use-before-declare in scope is fine here).
import * as acorn from 'acorn'

// What a page legitimately reads as a bare global: ES builtins + the browser APIs the apps use. Add a name here only when
// it is a real browser or ES global; never to silence a typo. Ambiguous window properties people mistype as locals
// (name, status, event, length, top, parent, open, close, find, stop, print, focus, blur) are deliberately absent.
// __pangea is the host's global (lib/build.mjs globalFor: shared svelte/three/ui come from __pangea.deps.*).
const names = (s) => s.trim().split(/\s+/u)
export const GLOBALS = new Set(names(`
undefined NaN Infinity globalThis arguments eval
Object Function Array String Number Boolean Symbol BigInt Math Date RegExp JSON Promise Proxy Reflect Map Set WeakMap WeakSet WeakRef FinalizationRegistry
Error EvalError RangeError ReferenceError SyntaxError TypeError URIError AggregateError DOMException
ArrayBuffer SharedArrayBuffer DataView Atomics Intl Iterator
Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array
parseInt parseFloat isNaN isFinite decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape queueMicrotask
window self document console navigator location history screen performance localStorage sessionStorage indexedDB caches crypto
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback
fetch Request Response Headers FormData URL URLSearchParams Blob File FileReader FileList AbortController AbortSignal XMLHttpRequest WebSocket EventSource BroadcastChannel MessageChannel MessagePort MessageEvent Worker SharedWorker
structuredClone atob btoa alert confirm prompt matchMedia getComputedStyle getSelection createImageBitmap
Event EventTarget CustomEvent KeyboardEvent MouseEvent PointerEvent WheelEvent TouchEvent FocusEvent InputEvent DragEvent ClipboardEvent CompositionEvent StorageEvent ErrorEvent ProgressEvent PromiseRejectionEvent
Node Element HTMLElement HTMLInputElement HTMLTextAreaElement HTMLCanvasElement HTMLImageElement HTMLVideoElement HTMLAudioElement HTMLButtonElement HTMLSelectElement HTMLTemplateElement HTMLIFrameElement SVGElement SVGSVGElement
Document DocumentFragment ShadowRoot Text Comment Range Selection NodeList HTMLCollection DOMRect DOMRectReadOnly DOMPoint DOMPointReadOnly DOMMatrix DOMMatrixReadOnly DOMParser XMLSerializer
MutationObserver ResizeObserver IntersectionObserver PerformanceObserver CSSStyleSheet CSS Image Audio Option
TextEncoder TextDecoder CompressionStream DecompressionStream ReadableStream WritableStream TransformStream
CanvasRenderingContext2D OffscreenCanvas ImageData ImageBitmap Path2D CanvasGradient CanvasPattern VideoFrame VideoDecoder VideoEncoder
WebGLRenderingContext WebGL2RenderingContext WebGLTexture WebGLBuffer WebGLProgram WebGLShader WebGLFramebuffer
GPU GPUAdapter GPUDevice GPUBuffer GPUTexture GPUBufferUsage GPUTextureUsage GPUShaderStage GPUMapMode GPUColorWrite GPUCommandEncoder GPUQueue
AudioContext AudioBuffer AudioWorkletNode webkitAudioContext OfflineAudioContext MediaRecorder MediaStream MediaSource
IDBKeyRange IDBDatabase IDBRequest IDBTransaction IDBFactory Notification Intl ServiceWorker ServiceWorkerRegistration
WebAssembly SharedArrayBuffer Atomics devicePixelRatio innerWidth innerHeight scrollX scrollY pageXOffset pageYOffset visualViewport
addEventListener removeEventListener dispatchEvent postMessage scrollTo scrollBy
__pangea
`))

class Scope {
  constructor(parent, fn) { this.parent = parent; this.fn = fn; this.names = new Set() }
  declare(n) { this.names.add(n) }
  has(n) { for (let s = this; s; s = s.parent) if (s.names.has(n)) return true; return false }
}

const FUNCS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const isNode = (v) => v && typeof v.type === 'string'

/** Every binding identifier in a pattern (declaration or parameter). */
function patternNames(p, out = []) {
  if (!p) return out
  switch (p.type) {
    case 'Identifier': out.push(p.name); break
    case 'ObjectPattern': for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, out); break
    case 'ArrayPattern': for (const q of p.elements) patternNames(q, out); break
    case 'RestElement': patternNames(p.argument, out); break
    case 'AssignmentPattern': patternNames(p.left, out); break
  }
  return out
}

/** The expressions inside a pattern (defaults, computed keys); for an assignment pattern also its target identifiers/members. */
function patternExprs(p, onExpr, target, onRef) {
  if (!p) return
  switch (p.type) {
    case 'Identifier': if (target) onRef(p); break
    case 'MemberExpression': if (target) onExpr(p); break
    case 'ObjectPattern':
      for (const q of p.properties) {
        if (q.type === 'RestElement') { patternExprs(q.argument, onExpr, target, onRef); continue }
        if (q.computed) onExpr(q.key)
        patternExprs(q.value, onExpr, target, onRef)
      }
      break
    case 'ArrayPattern': for (const q of p.elements) patternExprs(q, onExpr, target, onRef); break
    case 'RestElement': patternExprs(p.argument, onExpr, target, onRef); break
    case 'AssignmentPattern': patternExprs(p.left, onExpr, target, onRef); onExpr(p.right); break
  }
}

/** `var` and function declarations anywhere in a function body (not entering nested functions/classes): hoisted to the function scope. */
function hoistVars(node, scope) {
  if (!isNode(node)) return
  if (node.type === 'VariableDeclaration') { if (node.kind === 'var') for (const d of node.declarations) for (const n of patternNames(d.id)) scope.declare(n) }
  else if (node.type === 'FunctionDeclaration') { if (node.id) scope.declare(node.id.name); return } // sloppy-mode block functions are visible function-wide: no false alarm
  else if (FUNCS.has(node.type) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return
  for (const k of Object.keys(node)) {
    const v = node[k]
    if (Array.isArray(v)) { for (const c of v) if (isNode(c)) hoistVars(c, scope) } else if (isNode(v)) hoistVars(v, scope)
  }
}

/** Lexical declarations made directly by a statement list (let, const, class, function, import). */
function hoistLexical(stmts, scope) {
  for (let s of stmts) {
    if (s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration') s = s.declaration
    if (!s) continue
    if (s.type === 'VariableDeclaration') for (const d of s.declarations) for (const n of patternNames(d.id)) scope.declare(n)
    else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) scope.declare(s.id.name)
    else if (s.type === 'ImportDeclaration') for (const sp of s.specifiers) scope.declare(sp.local.name)
  }
}

function parse(source) {
  const base = { ecmaVersion: 'latest', locations: true, allowHashBang: true }
  try { return acorn.parse(source, { ...base, sourceType: 'module' }) } catch (e) {
    try { return acorn.parse(source, { ...base, sourceType: 'script' }) } catch { throw e } // the module error is the informative one
  }
}

/**
 * Unresolved references in `source`: [{ name, line, col }] (1-based line, 0-based column, in source order).
 * `globals`: extra names to allow beyond GLOBALS (e.g. a page's injected globals). Throws on a syntax error.
 */
export function checkUndef(source, { globals = [] } = {}) {
  const ast = parse(source)
  const allowed = new Set([...GLOBALS, ...globals])
  const refs = [] // { name, loc, scope }

  const visitAll = (list, scope) => { for (const n of list) if (n) visit(n, scope) }
  const block = (stmts, scope) => { hoistLexical(stmts, scope); visitAll(stmts, scope) }

  function fn(node, scope) {
    const s = new Scope(scope, true)
    if (node.type !== 'ArrowFunctionExpression') s.declare('arguments')
    if (node.type === 'FunctionExpression' && node.id) s.declare(node.id.name)
    for (const p of node.params) { for (const n of patternNames(p)) s.declare(n); patternExprs(p, (e) => visit(e, s), false) }
    if (node.body.type === 'BlockStatement') { hoistVars(node.body, s); block(node.body.body, s) } else visit(node.body, s)
  }

  function cls(node, scope) {
    const s = new Scope(scope, false)
    if (node.id) s.declare(node.id.name)
    if (node.superClass) visit(node.superClass, s)
    for (const m of node.body.body) {
      if (m.type === 'StaticBlock') { const b = new Scope(s, true); hoistVars({ type: 'BlockStatement', body: m.body }, b); block(m.body, b); continue }
      if (m.computed) visit(m.key, s)
      if (m.value) { if (FUNCS.has(m.value.type)) fn(m.value, s); else { const f = new Scope(s, true); f.declare('arguments'); visit(m.value, f) } }
    }
  }

  function visit(node, scope) {
    switch (node.type) {
      case 'Identifier': refs.push({ name: node.name, loc: node.loc.start, scope }); return
      case 'Program': { const s = new Scope(null, true); hoistVars(node, s); block(node.body, s); return }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': fn(node, scope); return
      case 'ClassDeclaration': case 'ClassExpression': cls(node, scope); return
      case 'BlockStatement': block(node.body, new Scope(scope, false)); return
      case 'StaticBlock': return
      case 'VariableDeclaration':
        for (const d of node.declarations) { patternExprs(d.id, (e) => visit(e, scope), false); if (d.init) visit(d.init, scope) }
        return
      case 'MemberExpression': visit(node.object, scope); if (node.computed) visit(node.property, scope); return
      case 'Property':
        if (node.computed) visit(node.key, scope)
        visit(node.value, scope) // shorthand: value is the Identifier, a real reference
        return
      case 'PropertyDefinition': case 'MethodDefinition': return // reached only through cls()
      case 'LabeledStatement': visit(node.body, scope); return
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': case 'ExportAllDeclaration': case 'EmptyStatement': return
      case 'ImportDeclaration': return // names declared by hoistLexical
      case 'ExportNamedDeclaration':
        if (node.declaration) visit(node.declaration, scope)
        else if (!node.source) for (const sp of node.specifiers) refs.push({ name: sp.local.name, loc: sp.local.loc.start, scope })
        return
      case 'ExportDefaultDeclaration': visit(node.declaration, scope); return
      case 'CatchClause': {
        const s = new Scope(scope, false)
        if (node.param) { for (const n of patternNames(node.param)) s.declare(n); patternExprs(node.param, (e) => visit(e, s), false) }
        block(node.body.body, new Scope(s, false)); return
      }
      case 'ForStatement': {
        const s = new Scope(scope, false)
        if (node.init?.type === 'VariableDeclaration') hoistLexical([node.init], s)
        if (node.init) visit(node.init, s)
        if (node.test) visit(node.test, s); if (node.update) visit(node.update, s)
        visit(node.body, s); return
      }
      case 'ForInStatement': case 'ForOfStatement': {
        const s = new Scope(scope, false)
        if (node.left.type === 'VariableDeclaration') { hoistLexical([node.left], s); visit(node.left, s) }
        else patternExprs(node.left, (e) => visit(e, s), true, (id) => visit(id, s))
        visit(node.right, s); visit(node.body, s); return
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope)
        const s = new Scope(scope, false)
        hoistLexical(node.cases.flatMap((c) => c.consequent), s)
        for (const c of node.cases) { if (c.test) visit(c.test, s); visitAll(c.consequent, s) }
        return
      }
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier' || node.left.type === 'MemberExpression') visit(node.left, scope)
        else patternExprs(node.left, (e) => visit(e, scope), true, (id) => visit(id, scope))
        visit(node.right, scope); return
      default:
        for (const k of Object.keys(node)) {
          if (k === 'loc' || k === 'type') continue
          const v = node[k]
          if (Array.isArray(v)) visitAll(v.filter(isNode), scope); else if (isNode(v)) visit(v, scope)
        }
    }
  }

  visit(ast, null)
  return refs.filter((r) => !r.scope.has(r.name) && !allowed.has(r.name))
    .map((r) => ({ name: r.name, line: r.loc.line, col: r.loc.column }))
    .sort((a, b) => a.line - b.line || a.col - b.col)
}

/**
 * Check one built part and format the findings for whoever edits the app (a person or a model): one
 * `undefined identifier <name> at <file>:<line>:<col>` line each, then the source line with a caret. [] when clean.
 */
export function undefReport(file, source, opts) {
  const lines = source.split('\n')
  return checkUndef(source, opts).map(({ name, line, col }) => {
    const text = lines[line - 1] ?? ''
    const start = Math.max(0, col - 60)
    return `undefined identifier ${name} at ${file}:${line}:${col}\n    ${text.slice(start, col + 80)}\n    ${' '.repeat(col - start)}^`
  })
}
