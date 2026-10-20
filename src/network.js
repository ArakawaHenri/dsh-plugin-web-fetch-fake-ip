import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

export const DEFAULT_ALLOW_CIDRS = Object.freeze(['198.18.0.0/15'])
export const MODES = Object.freeze(['fake-ip', 'off'])

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

function raceWithSignal(promise, signal) {
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal?.reason })
  if (signal?.aborted === true) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal?.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
}

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

export function createFakeIpResolver(options) {
  const { mode, allowCidrs = [], validatePublic, lookup: lookupImpl = lookup } = options
  if (!MODES.includes(mode)) {
    throw new Error(`unknown mode ${JSON.stringify(mode)}; expected one of ${MODES.join(', ')}`)
  }
  if (typeof validatePublic !== 'function') {
    throw new Error('createFakeIpResolver requires validatePublic')
  }
  const allowList = buildAllowList(allowCidrs)

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
      for (const entry of raw) {
        const type = entry.family === 6 ? 'ipv6' : 'ipv4'
        if (!allowList.check(entry.address, type) && !(await isPublicAddress(entry, hostname, signal))) {
          throw error
        }
      }
      return raw
    }
  }
}
