/**
 * Shape-compatible stub of `@deepseek-ai/dsh-web-fetch-http` for unit tests.
 *
 * `SHIPPED_DEFAULT_RESOLVER` plays the part of the shipped
 * `publicHttpNetwork.resolve`: it accepts a real public literal, and refuses a
 * literal from `NON_PUBLIC`. Hostnames never touch DNS here — the boot tests in
 * the README cover the real resolver against a real TUN resolver.
 */
import { isIP } from 'node:net'
import { WebError } from './dsh-web.js'

export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/** Addresses the stub's shipped resolver refuses, exactly as ipaddr.js would. */
export const NON_PUBLIC = new Set(['127.0.0.1', '::1', '10.0.0.5', '198.18.1.61'])

export const SHIPPED_DEFAULT_RESOLVER = async function shippedDefaultResolver(hostname, signal, resolver) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const literal = isIP(bare)
  const resolved = literal !== 0
    ? [{ address: bare, family: literal }]
    : await (resolver ?? (async () => [{ address: '203.0.113.7', family: 4 }]))(bare, { all: true, order: 'verbatim' })
  for (const entry of resolved) {
    if (NON_PUBLIC.has(entry.address)) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
  }
  return resolved
}

export class HttpFetchProvider {
  limits
  resolveAddresses
  id = LOCAL_FETCH_PROVIDER_ID

  constructor(limits, resolveAddresses = SHIPPED_DEFAULT_RESOLVER) {
    this.limits = limits
    this.resolveAddresses = resolveAddresses
  }

  available() {
    return true
  }

  async fetch(request, signal) {
    const addresses = await this.resolveAddresses(new URL(request.url).hostname, signal)
    return {
      url: request.url,
      statusCode: 200,
      body: { kind: 'text', content: 'stub' },
      truncated: false,
      addresses
    }
  }
}

export const name = 'web-fetch-http'
export const inject = ['web']
export function apply() {}
