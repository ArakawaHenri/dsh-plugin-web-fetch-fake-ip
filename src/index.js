import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { DEFAULT_ALLOW_CIDRS, MODES, createFakeIpResolver, parseCidr } from './network.js'

export const name = 'web-fetch-fake-ip'
export const inject = ['web']
export const DEFAULT_PROVIDER_ID = 'http'

const LIMIT_DEFAULTS = Object.freeze({
  maxResponseBytes: 5e6,
  maxBodyChars: 1e5,
  timeoutMs: 3e4,
  maxRedirects: 5
})

const MAX_NODE_TIMER_DELAY_MS = 2147483647

const CONFIG_KEYS = new Set([
  'mode',
  'allowCidrs',
  'providerId',
  ...Object.keys(LIMIT_DEFAULTS),
  'userAgent'
])

function assertPositiveFinite(key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-fake-ip: ${key} must be a positive finite number`)
  }
}

function assertNonNegativeInteger(key, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-fake-ip: ${key} must be a non-negative integer`)
  }
}

export function resolvePluginConfig(config = {}) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('web-fetch-fake-ip: config must be a mapping')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`web-fetch-fake-ip: unknown config key ${JSON.stringify(key)}; expected one of ${[...CONFIG_KEYS].join(', ')}`)
    }
  }

  const mode = config.mode ?? 'fake-ip'
  if (!MODES.includes(mode)) {
    throw new Error(`web-fetch-fake-ip: unknown mode ${JSON.stringify(mode)}; expected one of ${MODES.join(', ')}`)
  }

  const rawAllow = config.allowCidrs ?? DEFAULT_ALLOW_CIDRS
  if (!Array.isArray(rawAllow) || rawAllow.some((entry) => typeof entry !== 'string')) {
    throw new Error('web-fetch-fake-ip: allowCidrs must be a list of CIDR strings')
  }
  for (const entry of rawAllow) parseCidr(entry)

  const providerId = config.providerId ?? DEFAULT_PROVIDER_ID
  if (typeof providerId !== 'string' || providerId.length === 0) {
    throw new Error('web-fetch-fake-ip: providerId must be a non-empty string')
  }

  const limits = {}
  for (const [key, fallback] of Object.entries(LIMIT_DEFAULTS)) {
    limits[key] = config[key] ?? fallback
  }
  assertPositiveFinite('maxResponseBytes', limits.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', limits.maxBodyChars)
  assertPositiveFinite('timeoutMs', limits.timeoutMs)
  if (limits.timeoutMs > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-fake-ip: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
  assertNonNegativeInteger('maxRedirects', limits.maxRedirects)

  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT
  if (typeof userAgent !== 'string' || userAgent.length === 0) {
    throw new Error('web-fetch-fake-ip: userAgent must be a non-empty string')
  }

  return {
    mode,
    allowCidrs: [...rawAllow],
    providerId,
    userAgent,
    limits: { ...limits, userAgent }
  }
}

export class FakeIpHttpFetchProvider extends HttpFetchProvider {
  constructor(resolved) {
    super(resolved.limits)
    this.id = resolved.providerId
    const validatePublic = this.resolveAddresses
    this.resolveAddresses = createFakeIpResolver({
      mode: resolved.mode,
      allowCidrs: resolved.allowCidrs,
      validatePublic
    })
  }
}

export function apply(ctx, config) {
  const resolved = resolvePluginConfig(config)
  ctx.web.registerFetchProvider(new FakeIpHttpFetchProvider(resolved))
}
