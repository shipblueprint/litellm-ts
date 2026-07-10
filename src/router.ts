import { resolveProvider } from './config'
import type { ProviderHandler } from './providers/base'
import { openaiHandler } from './providers/openai'
import { anthropicHandler } from './providers/anthropic'
import { googleHandler } from './providers/google'
import { ollamaHandler } from './providers/ollama'
import { azureHandler } from './providers/azure'
import { isOnCooldown, markCooldown, logRequest } from './db'
import type { ChatCompletionRequest } from './types'

const handlers: Record<string, ProviderHandler> = {
  openai: openaiHandler,
  anthropic: anthropicHandler,
  google: googleHandler,
  groq: openaiHandler,
  together: openaiHandler,
  fireworks: openaiHandler,
  mistral: openaiHandler,
  xai: openaiHandler,
  deepseek: openaiHandler,
  sambanova: openaiHandler,
  cerebras: openaiHandler,
  deepinfra: openaiHandler,
  hyperbolic: openaiHandler,
  nebius: openaiHandler,
  novita: openaiHandler,
  friendliai: openaiHandler,
  openrouter: openaiHandler,
  github: openaiHandler,
  cloudflare: openaiHandler,
  ollama: ollamaHandler,
  azure: azureHandler,
}

const FALLBACK_CHAINS: Record<string, string[]> = {
  anthropic: ['gpt-4o', 'llama-3-70b-8192'],
  openai: ['claude-sonnet-4-20250514'],
  google: ['gpt-4o', 'claude-sonnet-4-20250514'],
  groq: ['gpt-4o'],
  together: ['gpt-4o'],
  fireworks: ['gpt-4o'],
  mistral: ['gpt-4o'],
  xai: ['gpt-4o'],
  deepseek: ['gpt-4o'],
  sambanova: ['gpt-4o'],
  cerebras: ['gpt-4o'],
  deepinfra: ['gpt-4o'],
  hyperbolic: ['gpt-4o'],
  nebius: ['gpt-4o'],
  novita: ['gpt-4o'],
  friendliai: ['gpt-4o'],
  openrouter: ['gpt-4o'],
  github: ['gpt-4o'],
  cloudflare: ['gpt-4o'],
  ollama: ['gpt-4o'],
  azure: ['gpt-4o'],
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

function isRetryable(status: number): boolean {
  return RETRYABLE_STATUSES.has(status)
}

export async function routeCompletion(
  body: ChatCompletionRequest,
  apiKey: string
): Promise<{ status: number; body: any }> {
  const route = resolveProvider(body.model)
  const handler = handlers[route.name]
  if (!handler) {
    return { status: 400, body: { error: { message: `No handler for provider: ${route.name}`, type: 'invalid_request_error', code: null, param: null } } }
  }

  const startTime = Date.now()
  let lastError: any = null

  const attempts = [
    { name: route.name, handler, baseUrl: route.baseUrl, model: body.model },
    ...(FALLBACK_CHAINS[route.name] || []).map(model => {
      const fallbackRoute = resolveProvider(model)
      return {
        name: fallbackRoute.name,
        handler: handlers[fallbackRoute.name],
        baseUrl: fallbackRoute.baseUrl,
        model,
      }
    }),
  ]

  for (const attempt of attempts) {
    if (!attempt.handler) continue
    if (isOnCooldown(attempt.name)) continue

    try {
      const requestBody = { ...body, model: attempt.model }
      const result = await attempt.handler.complete(requestBody, attempt.baseUrl, apiKey)
      const latency = Date.now() - startTime

      logRequest({
        model: attempt.model,
        provider: attempt.name,
        status: 200,
        latency_ms: latency,
      })

      return { status: 200, body: result }
    } catch (e: any) {
      lastError = e
      const status = e.status || 500
      const latency = Date.now() - startTime

      logRequest({
        model: attempt.model,
        provider: attempt.name,
        status,
        latency_ms: latency,
      })

      if (isRetryable(status) && attempts.length > 1) {
        markCooldown(attempt.name, 30000)
        continue
      }

      return {
        status,
        body: {
          error: {
            message: e.message || 'Provider error',
            type: status === 429 ? 'rate_limit_error' : 'api_error',
            code: null,
            param: null,
          },
        },
      }
    }
  }

  return {
    status: 503,
    body: {
      error: {
        message: `All providers exhausted. Last: ${lastError?.message || 'Unknown error'}`,
        type: 'server_error',
        code: null,
        param: null,
      },
    },
  }
}
