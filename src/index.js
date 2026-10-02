/**
 * `web-fetch-fake-ip`: a drop-in replacement for the shipped `http` fetch
 * provider of `ctx.web` that tolerates a TUN resolver in fake-IP mode.
 *
 * It is deliberately thin. `FakeIpHttpFetchProvider` extends the shipped
 * `HttpFetchProvider` and replaces only the instance's `resolveAddresses`
 * (the documented injection seam of that class): redirects, byte caps,
 * content-type handling, timeouts, proxy routing and connection pinning all
 * stay the shipped code, and the shipped public-address check still runs first
 * for every request. See `./network.js` for the address policy.
 *
 * @module dsh-plugin-web-fetch-fake-ip
 */
import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { DEFAULT_ALLOW_CIDRS, MODES, createFakeIpResolver, parseCidr } from './network.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-fake-ip'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * The provider id to register under. `http` is the id the `web` row already
 * pins (`fetchProvider: http`, from the dsh-base bundle layer), so taking it
 * over leaves the rest of the composition untouched.
 */
export const DEFAULT_PROVIDER_ID = 'http'

/** Transport and response limits, mirroring the shipped provider's defaults. */
const LIMIT_DEFAULTS = Object.freeze({
  maxResponseBytes: 5e6,
  maxBodyChars: 1e5,
  timeoutMs: 3e4,
  maxRedirects: 5
})

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
const MAX_NODE_TIMER_DELAY_MS = 2147483647

const CONFIG_KEYS = new Set([
  'mode',
  'allowCidrs',
  'providerId',
  ...Object.keys(LIMIT_DEFAULTS),
  'userAgent'
])

/** A resource limit must be a positive finite number. */
function assertPositiveFinite(key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-fake-ip: ${key} must be a positive finite number`)
  }
}

/** The redirect hop cap must be a non-negative integer (0 follows no redirects). */
function assertNonNegativeInteger(key, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-fake-ip: ${key} must be a non-negative integer`)
  }
}

/**
 * Validate and normalize the row config. Unknown keys are refused rather than
 * ignored, so a typo in a patch layer fails at boot instead of silently
 * fetching with defaults.
 *
 * @param config - the row's `config` object.
 * @returns the resolved policy and transport limits.
 * @throws {Error} for an unknown key or an invalid value.
 */
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
  if (!MODES.includes(mode)) throw new Error(`web-fetch-fake-ip: unknown mode ${JSON.stringify(mode)}; expected one of ${MODES.join(', ')}`)

  const rawAllow = config.allowCidrs ?? DEFAULT_ALLOW_CIDRS
  if (!Array.isArray(rawAllow) || rawAllow.some((entry) => typeof entry !== 'string')) {
    throw new Error('web-fetch-fake-ip: allowCidrs must be a list of CIDR strings')
  }
  // Parsed here as well so a malformed CIDR fails at boot, not on the first fetch.
  for (const entry of rawAllow) parseCidr(entry)

  const providerId = config.providerId ?? DEFAULT_PROVIDER_ID
  if (typeof providerId !== 'string' || providerId.length === 0) {
    throw new Error('web-fetch-fake-ip: providerId must be a non-empty string')
  }

  const limits = {}
  for (const [key, fallback] of Object.entries(LIMIT_DEFAULTS)) limits[key] = config[key] ?? fallback
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

  return { mode, allowCidrs: [...rawAllow], providerId, userAgent, limits: { ...limits, userAgent } }
}

/**
 * The shipped provider with its public-address check wrapped by the fake-IP
 * policy. Every other behavior is inherited unchanged.
 */
export class FakeIpHttpFetchProvider extends HttpFetchProvider {
  /**
   * @param resolved - output of {@link resolvePluginConfig}.
   */
  constructor(resolved) {
    super(resolved.limits)
    this.id = resolved.providerId
    // `super()` installed the shipped resolver (`publicHttpNetwork.resolve`);
    // keep it as the validator and wrap it. This is the class's injection seam.
    const validatePublic = this.resolveAddresses
    this.policy = Object.freeze({ mode: resolved.mode, allowCidrs: Object.freeze([...resolved.allowCidrs]) })
    this.resolveAddresses = createFakeIpResolver({
      mode: resolved.mode,
      allowCidrs: resolved.allowCidrs,
      validatePublic
    })
  }
}

/**
 * Register the fake-IP tolerant provider with `ctx.web`.
 *
 * @param ctx - the plugin context (requires the `web` service).
 * @param config - the row's `config` object.
 */
export function apply(ctx, config) {
  const resolved = resolvePluginConfig(config)
  ctx.web.registerFetchProvider(new FakeIpHttpFetchProvider(resolved))
  try {
    ctx.logger?.info?.(
      'web fetch provider %s registered (mode=%s, allowCidrs=%s)',
      resolved.providerId,
      resolved.mode,
      resolved.allowCidrs.join(', ') || '(none)'
    )
  } catch {
    // Logging is optional: a composition without a logger must not fail to mount.
  }
}
