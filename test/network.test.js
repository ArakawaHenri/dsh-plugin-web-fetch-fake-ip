import assert from 'node:assert/strict'
import { isIP } from 'node:net'
import { test } from 'node:test'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  buildAllowList,
  createFakeIpResolver,
  isWebBlocked,
  parseCidr,
  stripIpv6Brackets
} from '../src/network.js'

const FAKE_IP = '198.18.1.61'
const PUBLIC_V6 = '2606:4700::1111'

function shippedValidator({ lookup, nonPublic, nat64 = false }) {
  return async (hostname, signal, resolver) => {
    const bare = stripIpv6Brackets(hostname)
    const literal = isIP(bare)
    const resolved = literal !== 0
      ? [{ address: bare, family: literal }]
      : await (resolver ?? lookup)(bare, { all: true, order: 'verbatim' })
    if (resolved.length === 0) throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
    if (nat64 && resolved.some((entry) => entry.family === 6)) {
      // Mirror the shipped RFC 7050 discovery: it reuses the same resolver.
      await (resolver ?? lookup)('ipv4only.arpa', { all: true, order: 'verbatim' })
    }
    for (const entry of resolved) {
      if (nonPublic.has(entry.address)) {
        throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
      }
    }
    return resolved.map((entry) => ({ address: entry.address, family: isIP(entry.address) }))
  }
}

function fixture({ answers = {}, nonPublic = [FAKE_IP], nat64 = false } = {}) {
  const calls = []
  const lookup = async (hostname) => {
    calls.push(hostname)
    if (!(hostname in answers)) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    return answers[hostname]
  }
  const validatePublic = shippedValidator({ lookup, nonPublic: new Set(nonPublic), nat64 })
  return { calls, lookup, validatePublic }
}

test('parseCidr parses valid IPv4 and IPv6 CIDRs', () => {
  assert.deepEqual(parseCidr('198.18.0.0/15'), { address: '198.18.0.0', prefix: 15, family: 4 })
  assert.deepEqual(parseCidr('fc00::/7'), { address: 'fc00::', prefix: 7, family: 6 })
  assert.deepEqual(parseCidr('[fc00::]/7'), { address: 'fc00::', prefix: 7, family: 6 })
  assert.deepEqual(parseCidr(' 198.18.0.0/15 '), { address: '198.18.0.0', prefix: 15, family: 4 })
})

test('parseCidr rejects malformed input', () => {
  for (const bad of ['198.18.0.0', '198.18.0.0/33', '198.18.0.0/x', '010.1.1.1/8', 'not-an-ip/8', 'fc00::/129', '']) {
    assert.throws(() => parseCidr(bad), /invalid CIDR/, `expected throw for ${JSON.stringify(bad)}`)
  }
  assert.throws(() => parseCidr(null), TypeError)
})

test('buildAllowList matches configured IPv4 and IPv6 subnets', () => {
  const list = buildAllowList(['198.18.0.0/15', 'fc00::/7'])
  assert.equal(list.check('198.18.1.61', 'ipv4'), true)
  assert.equal(list.check('198.19.255.255', 'ipv4'), true)
  assert.equal(list.check('198.20.0.1', 'ipv4'), false)
  assert.equal(list.check('8.8.8.8', 'ipv4'), false)
  assert.equal(list.check('fd12:3456::1', 'ipv6'), true)
  assert.equal(list.check('fe80::1', 'ipv6'), false)
})

test('public DNS answers return with exactly one lookup', async () => {
  const { calls, lookup, validatePublic } = fixture({ answers: { 'ok.test': [{ address: '8.8.8.8', family: 4 }] } })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  assert.deepEqual(await resolve('ok.test', undefined), [{ address: '8.8.8.8', family: 4 }])
  assert.deepEqual(calls, ['ok.test'])
})

test('fake-ip mode admits allowCidrs answers with a single lookup', async () => {
  const { calls, lookup, validatePublic } = fixture({ answers: { 'github.com': [{ address: FAKE_IP, family: 4 }] } })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  assert.deepEqual(await resolve('github.com', undefined), [{ address: FAKE_IP, family: 4 }])
  assert.deepEqual(calls, ['github.com'], 'no fallback re-resolution of the same hostname')
})

test('fake-ip mode returns the full mixed answer set via one lookup', async () => {
  const { calls, lookup, validatePublic } = fixture({
    answers: { 'mixed.test': [{ address: FAKE_IP, family: 4 }, { address: PUBLIC_V6, family: 6 }] }
  })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  assert.deepEqual(await resolve('mixed.test', undefined), [
    { address: FAKE_IP, family: 4 },
    { address: PUBLIC_V6, family: 6 }
  ])
  assert.deepEqual(calls, ['mixed.test'])
})

test('fake-ip mode keeps the shipped refusal for non-admitted private addresses', async () => {
  const { lookup, validatePublic } = fixture({
    answers: { 'mixed.test': [{ address: FAKE_IP, family: 4 }, { address: '10.0.0.5', family: 4 }] },
    nonPublic: [FAKE_IP, '10.0.0.5']
  })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  await assert.rejects(resolve('mixed.test', undefined), (error) => error.code === 'WEB_BLOCKED_URL')
})

test('fake-ip mode blocks loopback and LAN literals and hostnames', async () => {
  const { lookup, validatePublic } = fixture({
    answers: { localhost: [{ address: '127.0.0.1', family: 4 }] },
    nonPublic: ['198.18.1.61', '127.0.0.1', '192.168.1.1']
  })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  for (const hostname of ['127.0.0.1', '192.168.1.1', 'localhost']) {
    await assert.rejects(resolve(hostname, undefined), (error) => error.code === 'WEB_BLOCKED_URL')
  }
})

test('fake-ip mode admits an allowlisted IP literal without any lookup', async () => {
  const { calls, lookup, validatePublic } = fixture()
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  assert.deepEqual(await resolve('198.18.1.61', undefined), [{ address: '198.18.1.61', family: 4 }])
  assert.deepEqual(calls, [])
})

for (const address of ['127.0.0.1', '10.0.0.5', '::1']) {
  test(`off mode admits a hostname resolving to ${address} with a single lookup`, async () => {
    const answers = [{ address, family: isIP(address) }]
    const { calls, lookup, validatePublic } = fixture({
      answers: { 'private.test': answers },
      nonPublic: [address]
    })
    const resolve = createFakeIpResolver({ mode: 'off', allowCidrs: [], validatePublic, lookup })
    assert.deepEqual(await resolve('private.test', undefined), answers)
    assert.deepEqual(calls, ['private.test'])
  })
}

test('off mode admits non-public IP literals without any lookup', async () => {
  const { calls, lookup, validatePublic } = fixture({ nonPublic: ['::1'] })
  const resolve = createFakeIpResolver({ mode: 'off', allowCidrs: [], validatePublic, lookup })
  assert.deepEqual(await resolve('[::1]', undefined), [{ address: '::1', family: 6 }])
  assert.deepEqual(calls, [])
})

test('NAT64 discovery lookups do not clobber the captured answer set', async () => {
  const { calls, lookup, validatePublic } = fixture({
    answers: {
      'v6.test': [{ address: PUBLIC_V6, family: 6 }, { address: FAKE_IP, family: 4 }],
      'ipv4only.arpa': [{ address: '64:ff9b::c000:aa', family: 6 }]
    },
    nat64: true
  })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  assert.deepEqual(await resolve('v6.test', undefined), [
    { address: PUBLIC_V6, family: 6 },
    { address: FAKE_IP, family: 4 }
  ])
  assert.deepEqual(calls, ['v6.test', 'ipv4only.arpa'], 'the discovery lookup happens but never replaces the answers')
})

test('non-policy failures propagate unchanged', async () => {
  let lookups = 0
  const validatePublic = async () => {
    throw new WebError('resolved to no addresses', 'WEB_PROVIDER_ERROR')
  }
  const resolve = createFakeIpResolver({
    mode: 'fake-ip',
    allowCidrs: [],
    validatePublic,
    lookup: async () => {
      lookups++
      return []
    }
  })
  await assert.rejects(resolve('x.test', undefined), (error) => error.code === 'WEB_PROVIDER_ERROR')
  assert.equal(lookups, 0, 'a non-policy failure never triggers an extra lookup')
})

test('createFakeIpResolver validates options at construction', () => {
  assert.throws(() => createFakeIpResolver({ mode: 'nope', allowCidrs: [], validatePublic: async () => [] }), /unknown mode/)
  assert.throws(() => createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['nope'], validatePublic: async () => [] }), /invalid CIDR/)
  assert.throws(() => createFakeIpResolver({ mode: 'fake-ip', allowCidrs: [] }), /validatePublic/)
})

test('isWebBlocked checks error code', () => {
  assert.equal(isWebBlocked(new WebError('blocked', 'WEB_BLOCKED_URL')), true)
  assert.equal(isWebBlocked(new WebError('other', 'WEB_PROVIDER_ERROR')), false)
  assert.equal(isWebBlocked(new Error('blocked')), false)
  assert.equal(isWebBlocked(undefined), false)
})
