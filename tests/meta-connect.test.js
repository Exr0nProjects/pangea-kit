import { it, expect } from 'vitest'
import { metaFor, cleanConnect } from '../lib/meta.js'

it('quicklook.json connect lands in meta.json as exact https/wss origins', () => {
  expect(metaFor({ connect: ['https://Compute.Example.com', 'wss://compute.example.com:8443', 'https://compute.example.com'] }, 'T'))
    .toEqual({ title: 'T', connect: ['https://compute.example.com', 'wss://compute.example.com:8443'] })
  expect(metaFor({}, 'T')).toEqual({ title: 'T' })
  expect(metaFor({ connect: [] }, 'T')).toEqual({ title: 'T' })
})
it('allows plain http/ws to loopback only', () => {
  expect(cleanConnect(['http://127.0.0.1:8790', 'ws://localhost:8790'])).toEqual(['http://127.0.0.1:8790', 'ws://localhost:8790'])
})
it('refuses wildcards, plain http, paths and non-arrays at publish time', () => {
  for (const bad of ['*', 'https://*.example.com', 'http://a.example', 'ws://a.example', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://10.0.0.1:8790', 'https://a.example/x', 'https://a.example; img-src *', 'https:', '']) {
    expect(() => cleanConnect([bad]), bad).toThrow(/connect/u)
  }
  expect(() => cleanConnect('https://a.example')).toThrow(/array/u)
})
