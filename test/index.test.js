import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_USER_AGENT, SHIPPED_DEFAULT_RESOLVER } from '@deepseek-ai/dsh-web-fetch-http'
import { Config, FakeIpHttpFetchProvider, apply, inject, name } from '../src/index.js'

test('plugin exports expected Cordis metadata', () => {
  assert.equal(name, 'web-fetch-fake-ip')
  assert.deepEqual(inject, ['web'])
})

test('Config resolves defaults', () => {
  assert.deepEqual(Config(), {
    mode: 'fake-ip',
    allowCidrs: ['198.18.0.0/15'],
    maxResponseBytes: 5e6,
    maxBodyChars: 1e5,
    timeoutMs: 3e4,
    maxRedirects: 5,
    userAgent: DEFAULT_USER_AGENT
  })
})

test('Config applies overrides', () => {
  const resolved = Config({ mode: 'off', allowCidrs: ['fc00::/7'], timeoutMs: 60000, userAgent: 'probe/1.0' })
  assert.equal(resolved.mode, 'off')
  assert.deepEqual(resolved.allowCidrs, ['fc00::/7'])
  assert.equal(resolved.timeoutMs, 60000)
  assert.equal(resolved.userAgent, 'probe/1.0')
})

test('Config rejects invalid values', () => {
  assert.throws(() => Config({ mode: 'sometimes' }), /expected "fake-ip" \| "off"/)
  assert.throws(() => Config({ timeoutMs: 0 }), /expected number >= 1/)
  assert.throws(() => Config({ timeoutMs: 2147483648 }), /expected number <= 2147483647/)
  assert.throws(() => Config({ maxRedirects: 1.5 }), /maxRedirects/)
  assert.throws(() => Config({ maxRedirects: -1 }), /expected number >= 0/)
})

test('apply rejects malformed CIDRs at boot', () => {
  const ctx = { web: { registerFetchProvider: () => {} } }
  assert.throws(() => apply(ctx, { allowCidrs: ['nope'] }), /invalid CIDR/)
})

test('FakeIpHttpFetchProvider wraps the shipped resolver under id http', () => {
  const provider = new FakeIpHttpFetchProvider(Config())
  assert.equal(provider.id, 'http')
  assert.equal(provider.available(), true)
  assert.notEqual(provider.resolveAddresses, SHIPPED_DEFAULT_RESOLVER)
  assert.equal(provider.limits.userAgent, DEFAULT_USER_AGENT)
  assert.deepEqual(
    [...Object.keys(provider.limits)].sort(),
    ['maxBodyChars', 'maxRedirects', 'maxResponseBytes', 'timeoutMs', 'userAgent']
  )
})

test('public IP literals pass in both modes', async () => {
  for (const mode of ['fake-ip', 'off']) {
    const provider = new FakeIpHttpFetchProvider(Config({ mode }))
    const result = await provider.fetch({ url: 'https://8.8.8.8/' }, undefined)
    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.addresses, [{ address: '8.8.8.8', family: 4 }])
  }
})

test('loopback literal is blocked in fake-ip mode and allowed in off mode', async () => {
  const strict = new FakeIpHttpFetchProvider(Config())
  await assert.rejects(
    strict.fetch({ url: 'http://127.0.0.1:8080/admin' }, undefined),
    (error) => error.code === 'WEB_BLOCKED_URL'
  )

  const permissive = new FakeIpHttpFetchProvider(Config({ mode: 'off' }))
  const result = await permissive.fetch({ url: 'http://127.0.0.1:8080/admin' }, undefined)
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.addresses, [{ address: '127.0.0.1', family: 4 }])
})

test('apply registers the provider with ctx.web', () => {
  const registered = []
  const ctx = { web: { registerFetchProvider: (provider) => registered.push(provider) } }
  apply(ctx, { mode: 'off' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'http')
})
