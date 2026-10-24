import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { DEFAULT_ALLOW_CIDRS, createFakeIpResolver, parseCidr } from './network.js'

export const name = 'dsh-plus-web-fetch-fake-ip'
export const inject = ['web']

export const Config = Schema.object({
  mode: Schema.union(['fake-ip', 'off']).default('fake-ip').description(
    'fake-ip: admit allowCidrs on top of the shipped public-address check; off: skip the check entirely (loopback and LAN become fetchable)',
  ),
  allowCidrs: Schema.array(Schema.string()).default(DEFAULT_ALLOW_CIDRS).description(
    'IPv4/IPv6 CIDRs admitted in fake-ip mode',
  ),
  maxResponseBytes: Schema.number().min(1).default(5e6),
  maxBodyChars: Schema.number().min(1).default(1e5),
  timeoutMs: Schema.number().min(1).max(2147483647).default(3e4),
  maxRedirects: Schema.number().min(0).step(1).default(5),
  userAgent: Schema.string().default(DEFAULT_USER_AGENT),
})

export class FakeIpHttpFetchProvider extends HttpFetchProvider {
  constructor({ mode, allowCidrs, ...limits }) {
    super(limits)
    const validatePublic = this.resolveAddresses
    this.resolveAddresses = createFakeIpResolver({ mode, allowCidrs, validatePublic })
  }
}

export function apply(ctx, config = {}) {
  const resolved = Config(config)
  // Reject malformed CIDRs at boot, not on the first fetch.
  for (const cidr of resolved.allowCidrs) parseCidr(cidr)
  ctx.web.registerFetchProvider(new FakeIpHttpFetchProvider(resolved))
}
