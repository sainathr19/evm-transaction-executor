import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildApp } from '../../src/app'

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = buildApp().listen(0, '127.0.0.1', () => resolve(listening))
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

test('GET /health responds', async () => {
  const res = await fetch(`${baseUrl}/health`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'ok' })
})

test('rejects a JSON body over the size limit', async () => {
  const res = await fetch(`${baseUrl}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: 'x'.repeat(300_000) }),
  })
  expect(res.status).toBe(413)
})
