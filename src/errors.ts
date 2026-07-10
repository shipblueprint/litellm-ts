import type { OpenAIErrorBody } from './types'

const STATUS_TYPE_MAP: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permissions_error',
  404: 'not_found',
  415: 'invalid_request_error',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'server_error',
  503: 'server_error',
  504: 'server_error',
}

export function normalizeError(err: any, providerName?: string): { status: number; body: OpenAIErrorBody } {
  const status = typeof err.status === 'number' ? err.status : 500

  let message = err.message || 'Unknown error'
  if (err.body?.error?.message) message = err.body.error.message
  if (err.error?.message) message = err.error.message

  const prefix = providerName ? `[${providerName}] ` : ''
  const type = STATUS_TYPE_MAP[status] || 'api_error'

  return {
    status,
    body: {
      error: {
        message: `${prefix}${message}`,
        type,
        code: err.code || err.body?.error?.code || null,
        param: err.param || err.body?.error?.param || null,
      },
    },
  }
}

export function errorResponse(err: any, providerName?: string): Response {
  const { status, body } = normalizeError(err, providerName)
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
