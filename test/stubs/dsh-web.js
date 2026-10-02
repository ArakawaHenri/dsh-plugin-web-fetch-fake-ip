/** Shape-compatible stub of `@deepseek-ai/dsh-web` for unit tests. */
export class WebError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}
