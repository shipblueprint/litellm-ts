const MAX_BODY_BYTES = 1024 * 1024 // 1MB

/**
 * Check request body size. Returns error response if too large.
 */
export function checkBodySize(contentLength: string | null | undefined): string | null {
  if (!contentLength) return null
  const bytes = parseInt(contentLength, 10)
  if (isNaN(bytes)) return null
  if (bytes > MAX_BODY_BYTES) {
    return `Request body too large (${(bytes / 1024 / 1024).toFixed(1)}MB). Max: 1MB.`
  }
  return null
}

/**
 * Sanitize error messages from upstream providers.
 * Strips potential API key fragments and sensitive info.
 */
export function sanitizeError(err: any): string {
  let msg = err?.message || err?.error?.message || 'Provider error'

  // Strip lines that look like they contain API keys
  msg = msg.replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***')
  msg = msg.replace(/Bearer\s+[a-zA-Z0-9_-]{20,}/g, 'Bearer ***')
  msg = msg.replace(/api[_-]?key[:\s=]+[a-zA-Z0-9_-]{20,}/gi, 'api_key=***')

  // Truncate very long messages
  if (msg.length > 500) msg = msg.slice(0, 500) + '...'

  return msg
}
