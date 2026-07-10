/**
 * Template for adding a new non-OpenAI provider.
 *
 * Steps to add a provider:
 * 1. Copy this file to `src/providers/yourprovider.ts`
 * 2. Fill in the TODO sections below
 * 3. Add a regex route in `src/config.ts` MODEL_ROUTES
 * 4. Register the handler in `src/index.ts` and `src/router.ts`
 * 5. Write tests in `tests/providers/yourprovider.test.ts`
 *
 * Reference implementations:
 * - Simple (passthrough): src/providers/openai.ts
 * - Complex (full translation): src/providers/anthropic.ts
 *
 * The key work is translating between OpenAI's message format and your
 * provider's native format. You need to handle:
 * - Message roles (system/user/assistant/tool)
 * - Content types (text, images via data URLs)
 * - Tool calling (function calls)
 * - Streaming (SSE chunk format)
 * - Error responses
 */

import type { ProviderHandler } from './base'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  Tool,
  ToolCall,
} from '../types'
import { createSSEParser, type SSEEvent } from '../streaming/sse-parser'

// ============================================================
// TODO: Define your provider's base URL and API paths
// ============================================================

const YOUR_PROVIDER_BASE = 'https://api.yourprovider.com'
const CHAT_PATH = '/v1/chat/completions' // adjust to your provider's endpoint
const MODELS_PATH = '/v1/models'         // adjust if your provider has one

// ============================================================
// TODO: Define your provider's request/response types
// ============================================================

interface YourProviderRequest {
  // Map OpenAI fields to your provider's format
  model: string
  messages: YourProviderMessage[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
  // ... add fields as needed
}

interface YourProviderMessage {
  role: string
  content: string
  // Add other fields your provider uses
}

interface YourProviderResponse {
  id: string
  model: string
  choices: { message: { role: string; content: string }; finish_reason: string }[]
  usage?: { prompt_tokens: number; completion_tokens: number }
  // Match your provider's actual response shape
}

// ============================================================
// STEP 1: Request Translation
// Convert OpenAI format → your provider's format
// ============================================================

function buildProviderRequest(body: ChatCompletionRequest): {
  url: string
  headers: Record<string, string>
  body: YourProviderRequest
} {
  const messages = convertMessages(body.messages)

  return {
    url: `${YOUR_PROVIDER_BASE}${CHAT_PATH}`,
    headers: {
      'Authorization': 'Bearer <filled by caller>', // or 'api-key' or whatever auth your provider uses
      'Content-Type': 'application/json',
    },
    body: {
      model: body.model,
      messages,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      stream: body.stream,
      // TODO: map other fields (tools, stop, top_p, etc.)
    },
  }
}

/**
 * TODO: Convert OpenAI messages to your provider's message format.
 *
 * OpenAI message roles: system, user, assistant, tool
 * Your provider may use different names or structures.
 *
 * Key things to handle:
 * - system messages → may need to be a separate parameter
 * - tool calls in assistant messages
 * - tool results in tool messages
 * - image content blocks (data URLs)
 */
function convertMessages(messages: ChatMessage[]): YourProviderMessage[] {
  return messages.map(msg => {
    // TODO: implement conversion
    // Simple case (OpenAI-compatible providers):
    return { role: msg.role, content: typeof msg.content === 'string' ? msg.content : '' }
  })
}

// ============================================================
// STEP 2: Response Translation
// Convert your provider's response → OpenAI format
// ============================================================

function transformResponse(providerRes: YourProviderResponse): ChatCompletionResponse {
  // TODO: implement conversion
  // This is the non-streaming response transform

  return {
    id: providerRes.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: providerRes.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: providerRes.choices[0]?.message.content ?? null,
        // TODO: map tool_calls if your provider supports them
      },
      finish_reason: providerRes.choices[0]?.finish_reason ?? null,
    }],
    usage: {
      prompt_tokens: providerRes.usage?.prompt_tokens ?? 0,
      completion_tokens: providerRes.usage?.completion_tokens ?? 0,
      total_tokens: (providerRes.usage?.prompt_tokens ?? 0) + (providerRes.usage?.completion_tokens ?? 0),
    },
  }
}

// ============================================================
// STEP 3: Streaming Translation
// Convert your provider's streaming chunks → OpenAI delta format
//
// Your provider likely sends SSE events with a different structure.
// You need to map each event to an OpenAI ChatCompletionChunk.
//
// Example OpenAI streaming chunk:
// {
//   id: "chatcmpl-123",
//   object: "chat.completion.chunk",
//   choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }]
// }
// ============================================================

function transformStreamChunk(data: any): { type: string; delta?: any; finish_reason?: string | null } | null {
  // TODO: map your provider's streaming events to OpenAI delta chunks
  //
  // Typical patterns:
  // - Your provider sends { choices: [{ text: "token" }] }
  //   → map to { delta: { content: "token" } }
  // - Your provider sends finish event
  //   → map to { finish_reason: "stop" }
  // - Your provider sends tool call chunks
  //   → map to { delta: { tool_calls: [...] } }

  return null
}

// ============================================================
// Handler Implementation
// ============================================================

export const yourProviderHandler: ProviderHandler = {

  async complete(body, baseUrl, apiKey) {
    const request = buildProviderRequest(body)
    request.headers['Authorization'] = `Bearer ${apiKey}`

    const res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw Object.assign(new Error(err.error?.message || 'Provider API error'), { status: res.status })
    }

    const providerResponse: YourProviderResponse = await res.json()
    return transformResponse(providerResponse)
  },

  async completeStream(body, baseUrl, apiKey) {
    const request = buildProviderRequest(body)
    request.headers['Authorization'] = `Bearer ${apiKey}`
    request.body.stream = true

    const res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw Object.assign(new Error(err.error?.message || 'Provider API error'), { status: res.status })
    }

    // Stream through SSE parser, transform each chunk
    return res.body!
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createSSEParser())
      .pipeThrough(new TransformStream<SSEEvent, string>({
        transform(event, controller) {
          try {
            const data = JSON.parse(event.data)
            const transformed = transformStreamChunk(data)
            if (transformed) {
              const chunk = {
                id: 'chatcmpl-stream', // TODO: use real ID from provider if available
                object: 'chat.completion.chunk' as const,
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [{
                  index: 0,
                  delta: transformed.delta || {},
                  finish_reason: transformed.finish_reason ?? null,
                }],
              }
              controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`)
            }
          } catch {
            // Skip malformed events
          }
        },
      }))
  },

  async getModels() {
    // TODO: fetch and return model list from your provider
    // Or return a hardcoded list if your provider has no models endpoint
    return [
      // { id: 'your-model-name', object: 'model', created: Date.now(), owned_by: 'yourprovider' },
    ]
  },
}
