import { registerHooks } from 'node:module'

const STUBS = {
  '@deepseek-ai/dsh-web': new URL('./stubs/dsh-web.js', import.meta.url).href,
  '@deepseek-ai/dsh-web-fetch-http': new URL('./stubs/dsh-web-fetch-http.js', import.meta.url).href
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier]
    if (stub !== undefined) return { url: stub, shortCircuit: true }
    return nextResolve(specifier, context)
  }
})
