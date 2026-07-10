import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { config, resolveProvider } from './config'
import { loadEnvFile, printStartupBanner } from './startup'
import { checkBodySize, sanitizeError } from './security'
import type { ProviderHandler } from './providers/base'
import { openaiHandler } from './providers/openai'
import { anthropicHandler } from './providers/anthropic'
import { googleHandler } from './providers/google'
import { ollamaHandler } from './providers/ollama'
import { azureHandler } from './providers/azure'
import { createSSEParser } from './streaming/sse-parser'
import type { ChatCompletionRequest, OpenAIErrorBody } from './types'

const app = new Hono()

// Optional: proxy-level auth check
if (config.proxyApiKey) {
  app.use('/v1/*', async (c, next) => {
    if (c.req.header('Authorization') !== `Bearer ${config.proxyApiKey}`) {
      return c.json({ error: { message: 'Invalid proxy API key', type: 'auth_error', code: null, param: null } }, 401)
    }
    await next()
  })
}

// Handler registry — all passthrough providers use openaiHandler
const handlers: Record<string, ProviderHandler> = {
  // Translation providers (different API format)
  openai: openaiHandler,
  anthropic: anthropicHandler,
  google: googleHandler,
  // OpenAI-compatible passthrough providers
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

// GET /v1/models
app.get('/v1/models', async (c) => {
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!apiKey) return c.json({ error: { message: 'Missing Authorization', type: 'auth_error' } }, 401)

  try {
    const models = await openaiHandler.getModels('https://api.openai.com', apiKey)
    return c.json({ object: 'list', data: models })
  } catch {
    return c.json({ object: 'list', data: [] })
  }
})

// POST /v1/chat/completions
app.post('/v1/chat/completions', async (c) => {
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!apiKey) {
    return c.json({ error: { message: 'Missing Authorization header', type: 'auth_error', code: null, param: null } }, 401)
  }

  // Body size limit (DoS prevention)
  const sizeError = checkBodySize(c.req.header('content-length'))
  if (sizeError) {
    return c.json({ error: { message: sizeError, type: 'invalid_request_error', code: null, param: null } }, 413)
  }

  let body: ChatCompletionRequest
  try {
    body = await c.req.json<ChatCompletionRequest>()
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: null, param: null } }, 400)
  }

  if (!body.model) {
    return c.json({ error: { message: 'model is required', type: 'invalid_request_error', code: null, param: 'model' } }, 400)
  }

  try {
    const route = resolveProvider(body.model)
    const handler = handlers[route.name]
    if (!handler) {
      return c.json({ error: { message: `Unknown provider: ${route.name}`, type: 'invalid_request_error', code: null, param: null } }, 400)
    }

    if (body.stream) {
      return await handleStreamingResponse(c, handler, body, route.baseUrl, apiKey)
    }

    const response = await handler.complete(body, route.baseUrl, apiKey)
    return c.json(response)
  } catch (e: any) {
    const status = e.status || 500
    const errorBody: OpenAIErrorBody = {
      error: {
        message: sanitizeError(e),
        type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'api_error',
        code: null,
        param: null,
      },
    }
    return c.json(errorBody, status)
  }
})

async function handleStreamingResponse(c: any, handler: ProviderHandler, body: ChatCompletionRequest, baseUrl: string, apiKey: string) {
  return streamSSE(c, async (stream) => {
    try {
      const upstream = await handler.completeStream(body, baseUrl, apiKey)
      const sseEvents = upstream.pipeThrough(createSSEParser())

      for await (const event of sseEvents) {
        if (stream.aborted) break
        await stream.writeSSE({
          data: event.data,
          event: event.event,
        })
      }
    } catch (e: any) {
      if (!stream.aborted) {
        await stream.writeSSE({
          data: JSON.stringify({ error: { message: sanitizeError(e), type: 'stream_error' } }),
          event: 'error',
        })
      }
    }
  })
}

await loadEnvFile()
printStartupBanner(config.port)

export default { port: config.port, fetch: app.fetch }
