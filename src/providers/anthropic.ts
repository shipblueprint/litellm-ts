import type { ProviderHandler } from './base'
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ContentBlock, Tool, ToolCall } from '../types'
import { createSSEParser, type SSEEvent } from '../streaming/sse-parser'
import { createAnthropicStreamTransformer } from '../streaming/anthropic'

// === Anthropic internal types ===

interface AnthropicMessage {
  role: string
  content: AnthropicContentBlock[]
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicResponse {
  id: string
  model: string
  type: string
  role: 'assistant'
  content: AnthropicResponseContentBlock[]
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'content_filtered'
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

type AnthropicResponseContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking'; data: string }

// === Parameter mapping ===

function safeParseJson(str: string): any {
  try { return JSON.parse(str) } catch { return {} }
}

function mapToolChoice(v: any): any {
  if (v === 'auto') return { type: 'auto' }
  if (v === 'required') return { type: 'any' }
  if (v === 'none') return { type: 'none' }
  if (v?.type === 'function') return { type: 'tool', name: v.function.name }
  return v
}

// === Message conversion ===

function convertOpenAIMessagesToAnthropic(messages: ChatMessage[], forwardToolMap?: Map<string, string>): {
  system: AnthropicContentBlock[]
  messages: AnthropicMessage[]
} {
  const system: AnthropicContentBlock[] = []
  const converted: AnthropicMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      system.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' })
      continue
    }

    if (msg.role === 'user') {
      converted.push({ role: 'user', content: convertUserContent(msg.content) })
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = []
      if (msg.content) {
        blocks.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' })
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          // Rewrite tool names using forward map (original → sanitized)
          let name = tc.function.name
          if (forwardToolMap?.has(name)) {
            name = forwardToolMap.get(name)!
          }
          blocks.push({ type: 'tool_use', id: tc.id, name, input: safeParseJson(tc.function.arguments) })
        }
      }
      converted.push({ role: 'assistant', content: blocks })
    }

    if (msg.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id!, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
      })
    }
  }

  const merged = mergeConsecutiveSameRole(converted)

  const first = merged[0]
  if (first && first.role !== 'user') {
    merged.unshift({ role: 'user', content: [{ type: 'text', text: 'Please continue.' }] })
  }

  return { system, messages: merged }
}

function convertUserContent(content: string | ContentBlock[] | null): AnthropicContentBlock[] {
  if (!content) return [{ type: 'text', text: '' }]
  if (typeof content === 'string') return [{ type: 'text', text: content }]

  return content.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text || '' }
    if (block.type === 'image_url') {
      const { mimeType, base64Data } = parseDataUrl(block.image_url!.url)
      return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } }
    }
    return { type: 'text', text: '' }
  })
}

function parseDataUrl(url: string): { mimeType: string; base64Data: string } {
  const match = url.match(/^data:(image\/\w+);base64,(.+)$/)
  if (!match || !match[1] || !match[2]) throw new Error('Invalid data URL for image')
  return { mimeType: match[1], base64Data: match[2] }
}

function mergeConsecutiveSameRole(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = []
  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.content = [...last.content, ...msg.content]
    } else {
      merged.push({ ...msg, content: [...msg.content] })
    }
  }
  return merged
}

// === Tool name sanitization with collision handling ===

const INVALID_TOOL_CHARS = /[^a-zA-Z0-9_-]/g
const TOOL_NAME_MAX_LEN = 128

function sanitizeToolNames(tools: Tool[]): {
  tools: Tool[]
  forwardMap: Map<string, string>
  reverseMap: Map<string, string>
} {
  const forwardMap = new Map<string, string>()
  const reverseMap = new Map<string, string>()
  const usedNames = new Set<string>()

  // First pass: reserve names that are already valid
  for (const tool of tools) {
    const original = tool.function.name
    const candidate = original.replace(INVALID_TOOL_CHARS, '_').slice(0, TOOL_NAME_MAX_LEN)
    if (candidate === original) {
      usedNames.add(candidate)
    }
  }

  // Second pass: sanitize and disambiguate
  for (const tool of tools) {
    const original = tool.function.name
    const candidate = original.replace(INVALID_TOOL_CHARS, '_').slice(0, TOOL_NAME_MAX_LEN)

    if (candidate === original) {
      // Name is already valid, no rewrite needed
      continue
    }

    // Skip if we already mapped this exact original (duplicate tools)
    if (forwardMap.has(original)) {
      continue
    }

    // Disambiguate: append _2, _3, etc. until unique
    let unique = candidate
    let n = 1
    while (usedNames.has(unique)) {
      n++
      const suffix = `_${n}`
      const head = candidate.slice(0, TOOL_NAME_MAX_LEN - suffix.length)
      unique = `${head}${suffix}`
    }

    forwardMap.set(original, unique)
    reverseMap.set(unique, original)
    usedNames.add(unique)
  }

  if (forwardMap.size === 0) {
    return { tools, forwardMap, reverseMap }
  }

  // Apply forward map to tools
  const sanitized = tools.map(tool => {
    const newName = forwardMap.get(tool.function.name)
    if (newName) {
      return {
        ...tool,
        function: { ...tool.function, name: newName },
      }
    }
    return tool
  })

  return { tools: sanitized, forwardMap, reverseMap }
}

// === Request building ===

function buildAnthropicRequest(body: ChatCompletionRequest): {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  forwardToolMap: Map<string, string>
  reverseToolMap: Map<string, string>
} {
  // Build tool name maps first so we can rewrite names in messages
  let forwardToolMap = new Map<string, string>()
  let reverseToolMap = new Map<string, string>()

  if (body.tools) {
    const maps = sanitizeToolNames(body.tools)
    forwardToolMap = maps.forwardMap
    reverseToolMap = maps.reverseMap
  }

  // Pass forward map to message conversion so tool_call names in assistant
  // messages get rewritten to the sanitized names
  const { system, messages } = convertOpenAIMessagesToAnthropic(body.messages, forwardToolMap)

  const payload: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens || 1024,
  }

  if (system.length > 0) payload.system = system

  if (body.temperature !== undefined) payload.temperature = body.temperature
  if (body.top_p !== undefined) payload.top_p = body.top_p
  if (body.stop !== undefined) {
    payload.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  }

  if (body.tools) {
    const { tools } = sanitizeToolNames(body.tools)
    payload.tools = tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }))
  }

  if (body.tool_choice) {
    const mapped = mapToolChoice(body.tool_choice)
    // Rewrite tool_choice name if it was sanitized
    if (mapped?.type === 'tool' && mapped.name && forwardToolMap.has(mapped.name)) {
      mapped.name = forwardToolMap.get(mapped.name)
    }
    payload.tool_choice = mapped
  }

  if (body.user) {
    payload.metadata = { ...(payload.metadata as any) || {}, user_id: body.user }
  }

  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: payload,
    forwardToolMap,
    reverseToolMap,
  }
}

// === Response transformation ===

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  content_filtered: 'content_filter',
}

function transformAnthropicResponse(anthropicRes: AnthropicResponse, reverseToolMap?: Map<string, string>): ChatCompletionResponse {
  let content = ''
  const toolCalls: ToolCall[] = []

  for (const block of anthropicRes.content) {
    if (block.type === 'text') {
      content += block.text
    } else if (block.type === 'tool_use') {
      let name = block.name
      if (reverseToolMap?.has(name)) {
        name = reverseToolMap.get(name)!
      }
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(block.input || {}),
        },
      })
    }
  }

  return {
    id: anthropicRes.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicRes.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: STOP_REASON_MAP[anthropicRes.stop_reason] || anthropicRes.stop_reason,
    }],
    usage: {
      prompt_tokens: anthropicRes.usage.input_tokens,
      completion_tokens: anthropicRes.usage.output_tokens,
      total_tokens: anthropicRes.usage.input_tokens + anthropicRes.usage.output_tokens,
      prompt_tokens_details: {
        cache_creation_tokens: anthropicRes.usage.cache_creation_input_tokens || 0,
        cached_tokens: anthropicRes.usage.cache_read_input_tokens || 0,
      },
    },
  }
}

// === Handler ===

export const anthropicHandler: ProviderHandler = {
  async complete(body, baseUrl, apiKey) {
    const request = buildAnthropicRequest(body)
    request.headers['x-api-key'] = apiKey

    const res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw Object.assign(new Error(err.error?.message || 'Anthropic API error'), { status: res.status })
    }

    const anthropicResponse = await res.json()
    return transformAnthropicResponse(anthropicResponse, request.reverseToolMap)
  },

  async completeStream(body, baseUrl, apiKey) {
    const request = buildAnthropicRequest(body)
    request.headers['x-api-key'] = apiKey
    request.body.stream = true

    const res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw Object.assign(new Error(err.error?.message || 'Anthropic API error'), { status: res.status })
    }

    // Per-stream transformer with reverse map for tool name un-sanitization
    const transformChunk = createAnthropicStreamTransformer(request.reverseToolMap)

    return res.body!
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createSSEParser())
      .pipeThrough(new TransformStream<SSEEvent, string>({
        transform(event, controller) {
          try {
            const data = JSON.parse(event.data)
            const chunk = transformChunk(event.event || '', data)
            if (chunk) {
              controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`)
            }
          } catch {
            // Skip malformed events
          }
        },
      }))
  },

  async getModels() {
    return [
      { id: 'claude-sonnet-4-20250514', object: 'model', created: 1747267200, owned_by: 'anthropic' },
      { id: 'claude-haiku-3-5-20241022', object: 'model', created: 1729555200, owned_by: 'anthropic' },
      { id: 'claude-opus-4-20250514', object: 'model', created: 1747267200, owned_by: 'anthropic' },
    ]
  },
}
