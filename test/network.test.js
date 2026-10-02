import assert from 'node:assert/strict'
import { isIP } from 'node:net'
import { test } from 'node:test'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  addressToBytes,
  cidrContains,
  createFakeIpResolver,
  isWebBlocked,
  parseCidr,
  resolveRawAddresses,
  stripIpv6Brackets
} from '../src/network.js'

const FAKE_IP = '198.18.1.61'
const PUBLIC_V6 = '2606:4700::1111'

/**
 * Stand-in for the shipped `resolvePublicAddresses`: it refuses the whole answer
 * set when any address is in `nonPublic`, and it honours the injected answer-set
 * override the same way the shipped function does.
 */
function shippedValidator({ lookup, nonPublic }) {
  return async (hostname, signal, resolver) => {
    const bare = stripIpv6Brackets(hostname)
    const literal = isIP(bare)
    const resolved = literal !== 0
      ? [{ address: bare, family: literal }]
      : await (resolver ?? lookup)(bare, { all: true, order: 'verbatim' })
    if (resolved.length === 0) throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
    for (const entry of resolved) {
      if (nonPublic.has(entry.address)) {
        throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
      }
    }
    return resolved.map((entry) => ({ address: entry.address, family: isIP(entry.address) }))
  }
}

/** A resolver with the shipped semantics minus the address ranges we exercise. */
function fixture({ answers = {}, nonPublic = [FAKE_IP] } = {}) {
  const calls = []
  const lookup = async (hostname) => {
    calls.push(hostname)
    if (!(hostname in answers)) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    return answers[hostname]
  }
  const validatePublic = shippedValidator({ lookup, nonPublic: new Set(nonPublic) })
  return { calls, lookup, validatePublic }
}

test('addressToBytes parses IPv4 and IPv6 literals', () => {
  assert.deepEqual([...addressToBytes('198.18.1.61')], [198, 18, 1, 61])
  assert.deepEqual([...addressToBytes('[198.18.1.61]')], [198, 18, 1, 61])
  assert.deepEqual([...addressToBytes('::1')], [...new Uint8Array(15), 1])
  assert.deepEqual([...addressToBytes('FE80::0001')], [0xfe, 0x80, ...new Uint8Array(13), 1])
  assert.deepEqual([...addressToBytes('2001:db8::1')], [0x20, 0x01, 0x0d, 0xb8, ...new Uint8Array(11), 1])
  assert.deepEqual([...addressToBytes('::ffff:198.18.0.1')], [...new Uint8Array(10), 0xff, 0xff, 198, 18, 0, 1])
  assert.deepEqual([...addressToBytes('::198.18.0.1')], [...new Uint8Array(12), 198, 18, 0, 1])
})

test('addressToBytes rejects non-addresses', () => {
  for (const bad of ['', 'localhost', '1.2.3', '198.18.0.256', '010.1.1.1', ':::1', '1::2::3', '2001:db8::1::2', null, 42]) {
    assert.equal(addressToBytes(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('parseCidr accepts the fake-IP range and both families', () => {
  assert.equal(parseCidr('198.18.0.0/15').prefix, 15)
  assert.equal(parseCidr('198.18.0.0/15').family, 4)
  assert.equal(parseCidr('fc00::/7').family, 6)
  assert.equal(parseCidr('::/0').prefix, 0)
  assert.equal(parseCidr(' 198.18.0.0/15 ').text, '198.18.0.0/15')
})

test('parseCidr rejects malformed input', () => {
  for (const bad of ['198.18.0.0', '198.18.0.0/33', '198.18.0.0/x', 'not-an-ip/8', 'fc00::/129', '']) {
    assert.throws(() => parseCidr(bad), /invalid CIDR/, `expected a throw for ${JSON.stringify(bad)}`)
  }
  assert.throws(() => parseCidr(null), TypeError)
})

test('cidrContains matches on prefix boundaries only', () => {
  const fakeIp = parseCidr('198.18.0.0/15')
  assert.equal(cidrContains(fakeIp, '198.18.0.0'), true)
  assert.equal(cidrContains(fakeIp, '198.18.1.61'), true)
  assert.equal(cidrContains(fakeIp, '198.19.255.255'), true)
  assert.equal(cidrContains(fakeIp, '198.20.0.1'), false)
  assert.equal(cidrContains(fakeIp, '198.17.255.255'), false)
  assert.equal(cidrContains(fakeIp, '8.8.8.8'), false)
  assert.equal(cidrContains(fakeIp, 'fd00::1'), false, 'family mismatch is never a match')
  assert.equal(cidrContains(parseCidr('8.8.8.8/32'), '8.8.8.8'), true)
  assert.equal(cidrContains(parseCidr('8.8.8.8/32'), '8.8.8.9'), false)
  assert.equal(cidrContains(parseCidr('0.0.0.0/0'), '203.0.113.9'), true)
  assert.equal(cidrContains(parseCidr('fc00::/7'), 'fd12:3456::1'), true)
  assert.equal(cidrContains(parseCidr('fc00::/7'), 'fc00::1'), true)
  assert.equal(cidrContains(parseCidr('fc00::/7'), 'fe80::1'), false)
})

test('resolveRawAddresses skips the lookup for IP literals', async () => {
  const { calls, lookup } = fixture()
  const resolved = await resolveRawAddresses('[::1]', undefined, lookup)
  assert.deepEqual(resolved, [{ address: '::1', family: 6 }])
  assert.deepEqual(calls, [])
})

test('resolveRawAddresses refuses an empty or malformed answer', async () => {
  await assert.rejects(
    resolveRawAddresses('empty.test', undefined, async () => []),
    (error) => error.code === 'WEB_PROVIDER_ERROR'
  )
  await assert.rejects(
    resolveRawAddresses('bad.test', undefined, async () => [{ address: 'not-an-ip', family: 4 }]),
    (error) => error.code === 'WEB_PROVIDER_ERROR'
  )
})

test('resolveRawAddresses normalizes a string family from the resolver', async () => {
  const resolved = await resolveRawAddresses('x.test', undefined, async () => [{ address: '198.18.2.3', family: 'IPv4' }])
  assert.deepEqual(resolved, [{ address: '198.18.2.3', family: 4 }])
})

test('the shipped verdict is returned untouched when it accepts', async () => {
  const { calls, lookup, validatePublic } = fixture({ answers: { 'ok.test': [{ address: '8.8.8.8', family: 4 }] } })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  assert.deepEqual(await resolve('ok.test', undefined), [{ address: '8.8.8.8', family: 4 }])
  assert.deepEqual(calls, ['ok.test'], 'the policy does not add its own lookup when the shipped check passes')
})

test('fake-ip mode admits the configured CIDR', async () => {
  const { lookup, validatePublic } = fixture({ answers: { 'github.com': [{ address: FAKE_IP, family: 4 }] } })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  assert.deepEqual(await resolve('github.com', undefined), [{ address: FAKE_IP, family: 4 }])
})

test('fake-ip mode admits a mixed answer set of fake-IP and real public addresses', async () => {
  const { lookup, validatePublic } = fixture({
    answers: { 'mixed.test': [{ address: FAKE_IP, family: 4 }, { address: PUBLIC_V6, family: 6 }] }
  })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  assert.deepEqual(await resolve('mixed.test', undefined), [
    { address: FAKE_IP, family: 4 },
    { address: PUBLIC_V6, family: 6 }
  ])
})

test('fake-ip mode keeps the shipped refusal for a genuinely non-public address', async () => {
  const { lookup, validatePublic } = fixture({
    answers: { 'mixed.test': [{ address: FAKE_IP, family: 4 }, { address: '10.0.0.5', family: 4 }] },
    nonPublic: [FAKE_IP, '10.0.0.5']
  })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  await assert.rejects(resolve('mixed.test', undefined), (error) => {
    assert.equal(error.code, 'WEB_BLOCKED_URL')
    assert.match(error.message, /non-public IP address/)
    return true
  })
})

test('fake-ip mode keeps loopback and LAN literals blocked', async () => {
  const { lookup, validatePublic } = fixture({
    answers: { localhost: [{ address: '127.0.0.1', family: 4 }] },
    nonPublic: ['198.18.1.61', '127.0.0.1', '192.168.1.1']
  })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  for (const hostname of ['127.0.0.1', '192.168.1.1', 'localhost']) {
    await assert.rejects(resolve(hostname, undefined), (error) => error.code === 'WEB_BLOCKED_URL', `${hostname} must stay blocked`)
  }
})

test('off mode returns the raw answer set when the shipped check refuses', async () => {
  const { lookup, validatePublic } = fixture({ answers: { 'localhost.test': [{ address: '127.0.0.1', family: 4 }] } })
  const resolve = createFakeIpResolver({ mode: 'off', allowCidrs: [], validatePublic, lookup })
  assert.deepEqual(await resolve('localhost.test', undefined), [{ address: '127.0.0.1', family: 4 }])
})

test('off mode still returns the shipped answer set when the shipped check accepts', async () => {
  const { lookup, validatePublic } = fixture({ answers: { 'ok.test': [{ address: '8.8.8.8', family: 4 }] } })
  const resolve = createFakeIpResolver({ mode: 'off', allowCidrs: [], validatePublic, lookup })
  assert.deepEqual(await resolve('ok.test', undefined), [{ address: '8.8.8.8', family: 4 }])
})

test('a shipped failure other than WEB_BLOCKED_URL propagates unchanged', async () => {
  let lookups = 0
  const validatePublic = async () => {
    throw new WebError('resolved to no addresses', 'WEB_PROVIDER_ERROR')
  }
  const resolve = createFakeIpResolver({
    mode: 'off',
    allowCidrs: [],
    validatePublic,
    lookup: async () => {
      lookups++
      return []
    }
  })
  await assert.rejects(resolve('x.test', undefined), (error) => error.code === 'WEB_PROVIDER_ERROR')
  assert.equal(lookups, 0, 'a non-policy failure does not trigger the raw lookup')
})

test('allowCidrs replaces the default range', async () => {
  const { lookup, validatePublic } = fixture({ nonPublic: ['10.0.0.5'] })
  const resolve = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['10.0.0.0/8'], validatePublic, lookup })
  assert.deepEqual(await resolve('10.0.0.5', undefined), [{ address: '10.0.0.5', family: 4 }])
  const strict = createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['198.18.0.0/15'], validatePublic, lookup })
  await assert.rejects(strict('10.0.0.5', undefined), (error) => error.code === 'WEB_BLOCKED_URL')
})

test('construction fails loudly for bad policy input', () => {
  assert.throws(() => createFakeIpResolver({ mode: 'nope', allowCidrs: [], validatePublic: async () => [] }), /unknown mode/)
  assert.throws(() => createFakeIpResolver({ mode: 'fake-ip', allowCidrs: ['nope'], validatePublic: async () => [] }), /invalid CIDR/)
  assert.throws(() => createFakeIpResolver({ mode: 'fake-ip', allowCidrs: [] }), /validatePublic/)
})

test('isWebBlocked keys on the shipped error code', () => {
  assert.equal(isWebBlocked(new WebError('blocked', 'WEB_BLOCKED_URL')), true)
  assert.equal(isWebBlocked(new WebError('other', 'WEB_PROVIDER_ERROR')), false)
  assert.equal(isWebBlocked(new Error('blocked')), false)
  assert.equal(isWebBlocked(undefined), false)
})
