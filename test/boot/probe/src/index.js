/** Test-only cordis plugin: fetch through `ctx.web` at boot and report the outcome. */
export const name = 'fakeip-probe'
export const inject = ['web']

export function apply(ctx, config) {
  const urls = config?.urls ?? []
  const delayMs = config?.delayMs ?? 1500
  setTimeout(async () => {
    for (const url of urls) {
      try {
        const result = await ctx.web.fetch({ url }, AbortSignal.timeout(20000))
        const text = String(result.body?.content ?? '').replace(/\s+/g, ' ').slice(0, 50)
        console.error(`[probe] OK   ${url} -> HTTP ${result.statusCode} ${result.body?.kind} :: ${text}`)
      } catch (error) {
        console.error(`[probe] FAIL ${url} -> ${error.code ?? error.name}: ${error.message}`)
      }
    }
    console.error('[probe] done')
    const exit = ctx.get?.('appExit')
    if (typeof exit === 'function') exit(0)
    else setTimeout(() => process.exit(0), 250)
  }, delayMs)
}
