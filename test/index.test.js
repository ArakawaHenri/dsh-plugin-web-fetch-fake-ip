import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_USER_AGENT, SHIPPED_DEFAULT_RESOLVER } from '@deepseek-ai/dsh-web-fetch-http'
import { FakeIpHttpFetchProvider, apply, inject, name, resolvePluginConfig } from '../src/index.js'

test('plugin exports expected Cordis metadata', () => {
  assert.equal(name, 'web-fetch-fake-ip')
  assert.deepEqual(inject, ['web'])
})

test('resolvePluginConfig returns default values', () => {
  const resolved = resolvePluginConfig()
  assert.equal(resolved.mode, 'fake-ip')
  assert.deepEqual(resolved.allowCidrs, ['198.18.0.0/15'])
  assert.equal(resolved.providerId, 'http')
  assert.deepEqual(resolved.limits, {
    maxResponseBytes: 5e6,
    maxBodyChars: 1e5,
    timeoutMs: 3e4,
    maxRedirects: 5,
    userAgent: DEFAULT_USER_AGENT
  })
})

test('resolvePluginConfig applies user overrides', () => {
  const resolved = resolvePluginConfig({
    mode: 'off',
    allowCidrs: ['10.0.0.0/8'],
    providerId: 'http-fakeip',
    timeoutMs: 60000,
    userAgent: 'probe/1.0'
  })
  assert.equal(resolved.mode, 'off')
  assert.deepEqual(resolved.allowCidrs, ['10.0.0.0/8'])
  assert.equal(resolved.providerId, 'http-fakeip')
  assert.equal(resolved.limits.timeoutMs, 60000)
  assert.equal(resolved.limits.userAgent, 'probe/1.0')
})

test('resolvePluginConfig rejects invalid config values', () => {
  assert.throws(() => resolvePluginConfig({ allowCidr: ['198.18.0.0/15'] }), /unknown config key "allowCidr"/)
  assert.throws(() => resolvePluginConfig({ mode: 'sometimes' }), /unknown mode/)
  assert.throws(() => resolvePluginConfig({ allowCidrs: '198.18.0.0/15' }), /allowCidrs must be a list/)
  assert.throws(() => resolvePluginConfig({ allowCidrs: ['nope'] }), /invalid CIDR/)
  assert.throws(() => resolvePluginConfig({ allowCidrs: [42] }), /allowCidrs must be a list/)
  assert.throws(() => resolvePluginConfig({ providerId: '' }), /providerId must be a non-empty string/)
  assert.throws(() => resolvePluginConfig({ userAgent: '' }), /userAgent must be a non-empty string/)
  assert.throws(() => resolvePluginConfig({ maxResponseBytes: 0 }), /maxResponseBytes must be a positive finite number/)
  assert.throws(() => resolvePluginConfig({ maxBodyChars: Number.NaN }), /maxBodyChars must be a positive finite number/)
  assert.throws(() => resolvePluginConfig({ maxRedirects: 1.5 }), /maxRedirects must be a non-negative integer/)
  assert.throws(() => resolvePluginConfig({ maxRedirects: -1 }), /maxRedirects must be a non-negative integer/)
  assert.throws(() => resolvePluginConfig({ timeoutMs: 2147483648 }), /timeoutMs must be no greater than/)
  assert.throws(() => resolvePluginConfig([]), /config must be a mapping/)
})

test('FakeIpHttpFetchProvider wraps the shipped resolver', () => {
  const provider = new FakeIpHttpFetchProvider(resolvePluginConfig())
  assert.equal(provider.id, 'http')
  assert.equal(provider.available(), true)
  assert.notEqual(provider.resolveAddresses, SHIPPED_DEFAULT_RESOLVER)
  assert.equal(provider.limits.userAgent, DEFAULT_USER_AGENT)
})

test('public IP literals pass in both modes', async () => {
  for (const mode of ['fake-ip', 'off']) {
    const provider = new FakeIpHttpFetchProvider(resolvePluginConfig({ mode }))
    const result = await provider.fetch({ url: 'https://8.8.8.8/' }, undefined)
    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.addresses, [{ address: '8.8.8.8', family: 4 }])
  }
})

test('loopback literal is blocked in fake-ip mode and allowed in off mode', async () => {
  const strict = new FakeIpHttpFetchProvider(resolvePluginConfig())
  await assert.rejects(
    strict.fetch({ url: 'http://127.0.0.1:8080/admin' }, undefined),
    (error) => error.code === 'WEB_BLOCKED_URL'
  )

  const permissive = new FakeIpHttpFetchProvider(resolvePluginConfig({ mode: 'off' }))
  const result = await permissive.fetch({ url: 'http://127.0.0.1:8080/admin' }, undefined)
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.addresses, [{ address: '127.0.0.1', family: 4 }])
})

test('apply registers the provider with ctx.web', () => {
  const registered = []
  const ctx = { web: { registerFetchProvider: (provider) => registered.push(provider) } }
  apply(ctx, { mode: 'off', providerId: 'http-fakeip' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'http-fakeip')
})
