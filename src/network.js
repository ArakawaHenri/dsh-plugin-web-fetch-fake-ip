/**
 * Address policy for the fake-IP aware `web_fetch` provider.
 *
 * The shipped `http` provider validates every DNS answer with `ipaddr.js` and
 * refuses the whole answer set when any address is not global unicast. A TUN
 * resolver in fake-IP mode answers *every* name from a reserved range
 * (`198.18.0.0/15`, RFC 2544 benchmarking), which `ipaddr.js` classifies as
 * `reserved` rather than `unicast`, so every fetch fails with `WEB_BLOCKED_URL`.
 *
 * This module keeps that check and adds exactly one thing: addresses inside the
 * configured CIDRs are allowed even though the shipped check refuses them.
 * Every other address is still judged by the shipped check itself
 * (`validatePublic`), which is why nothing here re-implements an address range
 * table that could drift from the harness's own.
 *
 * Two modes:
 * - `fake-ip`: allow the configured CIDRs (default `198.18.0.0/15`) plus
 *   everything the shipped check already accepts; every other destination keeps
 *   the shipped refusal, so loopback, RFC 1918, link-local, CGNAT and cloud
 *   metadata endpoints stay unreachable.
 * - `off`: cancel the address check: when the shipped check refuses, the
 *   hostname's own resolved addresses are returned unvalidated.
 *
 * @module dsh-plugin-web-fetch-fake-ip/network
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

/** The fake-IP range default shipped by Clash/mihomo `fake-ip` mode. */
export const DEFAULT_ALLOW_CIDRS = Object.freeze(['198.18.0.0/15'])

/** The supported policy modes. */
export const MODES = Object.freeze(['fake-ip', 'off'])

/** WHATWG `URL` keeps brackets around IPv6 hostnames; IP parsers do not. */
export function stripIpv6Brackets(hostname) {
  return typeof hostname === 'string' && hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

/** Parse a dotted-quad IPv4 literal into four bytes, or return `null`. */
function ipv4ToBytes(text) {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (let index = 0; index < 4; index++) {
    // Leading zeros are rejected: `010` is ambiguous and `net.isIP` rejects it too.
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[index])) return null
    const value = Number(parts[index])
    if (value > 255) return null
    bytes[index] = value
  }
  return bytes
}

/**
 * Expand a well-formed IPv6 literal into sixteen bytes. Callers gate on
 * `net.isIP`, so this only has to handle valid text: `::` compression, an
 * embedded IPv4 tail, uppercase hex, and a `%zone` suffix.
 */
function ipv6ToBytes(text) {
  let source = text
  const zone = source.indexOf('%')
  if (zone !== -1) source = source.slice(0, zone)

  let embedded = null
  const lastColon = source.lastIndexOf(':')
  const tail = source.slice(lastColon + 1)
  if (tail.includes('.')) {
    embedded = ipv4ToBytes(tail)
    if (embedded === null) return null
    source = source.slice(0, lastColon + 1)
  }

  const groups = []
  const compression = source.indexOf('::')
  if (compression === -1) {
    const parts = source === '' ? [] : source.split(':')
    for (const part of parts) groups.push(parseHextet(part))
  } else {
    if (source.indexOf('::', compression + 1) !== -1) return null
    const head = source.slice(0, compression)
    let rest = source.slice(compression + 2)
    if (rest.endsWith(':')) rest = rest.slice(0, -1)
    for (const part of head === '' ? [] : head.split(':')) groups.push(parseHextet(part))
    const tailGroups = rest === '' ? [] : rest.split(':').map(parseHextet)
    const embeddedGroups = embedded === null ? 0 : 2
    const zeros = 8 - groups.length - tailGroups.length - embeddedGroups
    if (zeros < 1) return null
    for (let index = 0; index < zeros; index++) groups.push(0)
    for (const group of tailGroups) groups.push(group)
  }

  if (groups.some((group) => group === null)) return null
  if (groups.length + (embedded === null ? 0 : 2) !== 8) return null

  const bytes = new Uint8Array(16)
  for (let index = 0; index < groups.length; index++) {
    bytes[index * 2] = groups[index] >> 8
    bytes[index * 2 + 1] = groups[index] & 0xff
  }
  if (embedded !== null) bytes.set(embedded, 12)
  return bytes
}

/** One IPv6 hextet as a number, or `null` when it is not 1-4 hex digits. */
function parseHextet(text) {
  if (!/^[0-9a-fA-F]{1,4}$/.test(text)) return null
  return Number.parseInt(text, 16)
}

/**
 * The four or sixteen bytes of an IPv4/IPv6 literal (brackets, surrounding
 * whitespace and an IPv6 zone suffix are tolerated), or `null` when the input
 * is not an IP address.
 *
 * @param address - candidate address text.
 * @returns the address bytes, or `null`.
 */
export function addressToBytes(address) {
  if (typeof address !== 'string') return null
  const bare = stripIpv6Brackets(address.trim())
  const family = isIP(bare)
  if (family === 4) return ipv4ToBytes(bare)
  if (family === 6) return ipv6ToBytes(bare)
  return null
}

/**
 * Parse `address/prefix` into a comparable CIDR.
 *
 * @param text - CIDR text such as `198.18.0.0/15` or `fc00::/7`.
 * @returns the parsed CIDR.
 * @throws {Error} when the address or the prefix length is invalid.
 */
export function parseCidr(text) {
  if (typeof text !== 'string') throw new TypeError(`invalid CIDR ${JSON.stringify(text)}: expected a string`)
  const trimmed = text.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash === -1) throw new Error(`invalid CIDR ${JSON.stringify(text)}: expected <address>/<prefixLength>`)
  const address = trimmed.slice(0, slash)
  const prefixText = trimmed.slice(slash + 1)
  const bytes = addressToBytes(address)
  if (bytes === null) throw new Error(`invalid CIDR ${JSON.stringify(text)}: ${JSON.stringify(address)} is not an IP address`)
  if (!/^\d{1,3}$/.test(prefixText)) throw new Error(`invalid CIDR ${JSON.stringify(text)}: prefix length must be a number`)
  const prefix = Number(prefixText)
  if (prefix > bytes.length * 8) throw new Error(`invalid CIDR ${JSON.stringify(text)}: prefix length exceeds ${bytes.length * 8}`)
  return { text: trimmed, family: bytes.length === 4 ? 4 : 6, bytes, prefix }
}

/**
 * Whether an address falls inside a parsed CIDR. A family mismatch, an
 * unparsable address, or a `null`/`undefined` CIDR is `false`.
 *
 * @param cidr - a value from {@link parseCidr}.
 * @param address - candidate address text.
 * @returns true when the address's leading `prefix` bits match the CIDR's.
 */
export function cidrContains(cidr, address) {
  const bytes = addressToBytes(address)
  if (bytes === null || cidr === null || cidr === undefined || bytes.length !== cidr.bytes.length) return false
  let remaining = cidr.prefix
  for (let index = 0; index < bytes.length && remaining > 0; index++) {
    const bits = Math.min(8, remaining)
    const mask = bits === 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if ((bytes[index] & mask) !== (cidr.bytes[index] & mask)) return false
    remaining -= bits
  }
  return true
}

/** Whether an error is the shipped provider's non-public-address refusal. */
export function isWebBlocked(error) {
  return typeof error === 'object' && error !== null && error.code === 'WEB_BLOCKED_URL'
}

/** Race a non-cancellable OS lookup without letting it delay tool cancellation. */
function raceWithSignal(promise, signal) {
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal?.reason })
  if (signal?.aborted === true) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal?.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
}

/**
 * Resolve a hostname to the raw answers the OS gives us, with the same shape
 * checks the shipped resolver applies (an IP literal needs no lookup).
 *
 * @param hostname - URL hostname, bracketed when it is an IPv6 literal.
 * @param signal - aborts the wait for system resolution.
 * @param lookupImpl - `node:dns/promises` lookup, injectable for tests.
 * @returns the resolved address set.
 * @throws {WebError} `WEB_PROVIDER_ERROR` for an empty or malformed answer.
 */
export async function resolveRawAddresses(hostname, signal, lookupImpl = lookup) {
  const bare = stripIpv6Brackets(hostname)
  const literalFamily = isIP(bare)
  const resolved = literalFamily === 0
    ? await raceWithSignal(lookupImpl(bare, { all: true, order: 'verbatim' }), signal)
    : [{ address: bare, family: literalFamily }]
  if (!Array.isArray(resolved) || resolved.length === 0) {
    throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }
  const addresses = []
  for (const entry of resolved) {
    const family = typeof entry?.address === 'string' ? isIP(entry.address) : 0
    if (family !== 4 && family !== 6) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    addresses.push({ address: entry.address, family })
  }
  return addresses
}

/**
 * Build the resolver the replacement provider installs in place of the shipped
 * public-address resolver.
 *
 * The shipped resolver runs first and unchanged. Only when it refuses with
 * `WEB_BLOCKED_URL` does this policy look at what it refused: addresses inside
 * `allowCidrs` are admitted, mode `off` admits the whole answer set, and
 * anything else keeps the shipped refusal.
 *
 * @param options - policy and the shipped validator.
 * @param options.mode - `fake-ip` or `off`.
 * @param options.allowCidrs - CIDR texts admitted in `fake-ip` mode.
 * @param options.validatePublic - the shipped resolver, called with an optional answer-set override.
 * @param options.lookup - raw lookup, injectable for tests.
 * @returns an address resolver for `HttpFetchProvider`.
 * @throws {Error} for an unknown mode or an invalid CIDR (fail at construction, not at fetch time).
 */
export function createFakeIpResolver(options) {
  const { mode, allowCidrs = [], validatePublic, lookup: lookupImpl = lookup } = options
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${JSON.stringify(mode)}; expected one of ${MODES.join(', ')}`)
  if (typeof validatePublic !== 'function') throw new Error('createFakeIpResolver requires the shipped validatePublic resolver')
  const cidrs = allowCidrs.map(parseCidr)

  /** Ask the shipped validator about one address by handing it a one-entry answer set. */
  const isPublicAddress = async (entry, hostname, signal) => {
    try {
      await validatePublic(hostname, signal, async () => [entry])
      return true
    } catch (error) {
      if (isWebBlocked(error)) return false
      throw error
    }
  }

  return async function resolveAddresses(hostname, signal) {
    try {
      return await validatePublic(hostname, signal)
    } catch (error) {
      if (!isWebBlocked(error)) throw error
      const raw = await resolveRawAddresses(hostname, signal, lookupImpl)
      if (mode === 'off') return raw
      const allowed = []
      for (const entry of raw) {
        if (cidrs.some((cidr) => cidrContains(cidr, entry.address)) || await isPublicAddress(entry, hostname, signal)) {
          allowed.push(entry)
          continue
        }
        throw error
      }
      return allowed
    }
  }
}
