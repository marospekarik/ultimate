import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'vitest'
import { compress } from '../server/compress.ts'

const big = 'export const x = 1\n'.repeat(500)

async function serve<T>(run: (url: string) => Promise<T>) {
  const server = createServer((request, response) => {
    compress(request, response)
    if (request.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(': one\n\n')
      setImmediate(() => response.end(': two\n\n'))
    } else if (request.url === '/small') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 2 })
      response.end('{}')
    } else {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(big)
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.close()
  }
}
const remote = { 'X-Forwarded-For': '100.64.0.1', 'Accept-Encoding': 'gzip, br' }

test('a remote client gets large text compressed, and fetch decodes it', () =>
  serve(async (url) => {
    const response = await fetch(`${url}/a.js`, { headers: remote })
    assert.equal(response.headers.get('content-encoding'), 'br')
    assert.equal(await response.text(), big)
  }))

test('loopback clients, event streams and small bodies are not compressed', () =>
  serve(async (url) => {
    const local = await fetch(`${url}/a.js`, { headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(local.headers.get('content-encoding'), null)
    const events = await fetch(`${url}/events`, { headers: remote })
    assert.equal(events.headers.get('content-encoding'), null)
    assert.equal(await events.text(), ': one\n\n: two\n\n')
    const small = await fetch(`${url}/small`, { headers: remote })
    assert.equal(small.headers.get('content-encoding'), null)
    assert.equal(await small.text(), '{}')
  }))
