import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

/** The fake-IP range Clash/mihomo/sing-box hand out by default (RFC 2544). */
export const DEFAULT_ALLOW_CIDRS = Object.freeze(['198.18.0.0/15'])

/** WHATWG `URL` keeps brackets around IPv6 hostnames; IP parsers do not. */
export function stripIpv6Brackets(hostname) {
  return typeof hostname === 'string' && hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

export function parseCidr(text) {
  if (typeof text !== 'string') throw new TypeError(`invalid CIDR ${JSON.stringify(text)}: expected a string`)
  const trimmed = text.trim()
  const slash = trimmed.lastIndexOf('/')
  if (slash === -1) throw new Error(`invalid CIDR ${JSON.stringify(text)}: expected <address>/<prefix>`)
  const address = stripIpv6Brackets(trimmed.slice(0, slash))
  const prefixText = trimmed.slice(slash + 1)
  const family = isIP(address)
  if (family === 0) throw new Error(`invalid CIDR ${JSON.stringify(text)}: ${JSON.stringify(address)} is not an IP address`)
  if (!/^\d{1,3}$/.test(prefixText)) throw new Error(`invalid CIDR ${JSON.stringify(text)}: prefix length must be a number`)
  const prefix = Number(prefixText)
  const maxPrefix = family === 4 ? 32 : 128
  if (prefix > maxPrefix) throw new Error(`invalid CIDR ${JSON.stringify(text)}: prefix length exceeds ${maxPrefix}`)
  return { address, prefix, family }
}

export function buildAllowList(cidrs) {
  const list = new BlockList()
  for (const raw of cidrs) {
    const { address, prefix, family } = parseCidr(raw)
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

export function isWebBlocked(error) {
  return typeof error === 'object' && error !== null && error.code === 'WEB_BLOCKED_URL'
}

/** Normalize DNS answers to `{ address, family }` with numeric families, or `undefined` when empty. */
function normalizeAnswers(hostname, answers) {
  if (!Array.isArray(answers) || answers.length === 0) return undefined
  return answers.map((entry) => {
    const family = typeof entry?.address === 'string' ? isIP(entry.address) : 0
    if (family !== 4 && family !== 6) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    return { address: entry.address, family }
  })
}

/**
 * Wrap the shipped resolver so a hostname's DNS answers are seen exactly once.
 *
 * The shipped check (`resolvePublicAddresses`) accepts a lookup override as its
 * third argument, so we intercept its single lookup: in `fake-ip` mode the
 * allowlisted answers are held back and the rest is judged by the shipped check
 * unchanged (NAT64 discovery included, since `ipv4only.arpa` passes through);
 * in `off` mode nothing is held back and only the refusal is overridden.
 */
export function createFakeIpResolver({ mode, allowCidrs = [], validatePublic, lookup: lookupImpl = lookup }) {
  if (mode !== 'fake-ip' && mode !== 'off') {
    throw new Error(`unknown mode ${JSON.stringify(mode)}; expected 'fake-ip' or 'off'`)
  }
  if (typeof validatePublic !== 'function') {
    throw new Error('createFakeIpResolver requires validatePublic')
  }
  const allowList = buildAllowList(allowCidrs)
  const admits = (entry) =>
    mode === 'fake-ip' && allowList.check(entry.address, entry.family === 6 ? 'ipv6' : 'ipv4')

  return async function resolveAddresses(hostname, signal) {
    const bare = stripIpv6Brackets(hostname)
    let raw
    const resolver = async (host, options) => {
      const answers = await lookupImpl(host, options)
      if (host !== bare) return answers // the shipped NAT64 discovery of ipv4only.arpa
      raw = normalizeAnswers(hostname, answers)
      if (mode === 'off' || raw === undefined) return answers
      // Hold the allowlisted answers back so the shipped check judges only the
      // rest. When nothing remains, hand the full set back instead: the shipped
      // check then refuses it with WEB_BLOCKED_URL, which the catch below
      // recognizes without coupling to any error message text.
      const remainder = raw.filter((entry) => !admits(entry))
      return remainder.length > 0 ? remainder : raw
    }

    let validated
    try {
      validated = await validatePublic(hostname, signal, resolver)
    } catch (error) {
      // The shipped check refused a set consisting entirely of allowlisted addresses.
      if (raw !== undefined && raw.length > 0 && raw.every(admits)) return raw
      if (!isWebBlocked(error)) throw error
      if (mode === 'off' && raw !== undefined) return raw
      const family = isIP(bare)
      if (family !== 0) {
        const literal = { address: bare, family }
        if (mode === 'off' || admits(literal)) return [literal]
      }
      throw error
    }
    // A mixed answer set: the shipped check passed the non-allowlisted remainder.
    return raw ?? validated
  }
}
