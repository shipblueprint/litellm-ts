import type { ProviderHandler } from './base'
import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ToolCall } from '../types'
import { createOllamaStreamTransformer } from '../streaming/ollama'

// === Ollama internal types ===

interface OllamaMessage {
  role: string
  content: string
  images?: string[]
  tool_calls?: { function: { name: string; arguments: any } }[]
  tool_call_id?: string
}

interface OllamaRequest {
  model: string
  messages: OllamaMessage[]
  stream?: boolean
  format?: string | Record<string, unknown>
  options?: Record<string, unknown>
  tools?: { type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[]
  think?: boolean
}

interface OllamaResponse {
  model: string
  created_at: string
  message: {
    role: string
    content: string
    thinking?: string
    tool_calls?: { function: { name: string; arguments: any } }[]
  }
  done: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  total_duration?: number
}

// === Message conversion ===

function convertMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map(msg => {
    if (msg.role === 'system') {
      return { role: 'system', content: flattenContent(msg.content) }
    }

    if (msg.role === 'user') {
      const { content, images } = extractUserContent(msg.content)
      const ollamaMsg: OllamaMessage = { role: 'user', content }
      if (images.length > 0) ollamaMsg.images = images
      return ollamaMsg
    }

    if (msg.role === 'assistant') {
      const ollamaMsg: OllamaMessage = { role: 'assistant', content: flattenContent(msg.content) || '' }
      if (msg.tool_calls) {
        ollamaMsg.tool_calls = msg.tool_calls.map(tc => ({
          function: {
            name: tc.function.name,
            arguments: safeParseJson(tc.function.arguments),
          },
        }))
      }
      return ollamaMsg
    }

    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        tool_call_id: msg.tool_call_id,
      }
    }

    return { role: msg.role, content: flattenContent(msg.content) }
  })
}

function flattenContent(content: string | any[] | null | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join('')
  }
  return ''
}

function extractUserContent(content: string | any[] | null | undefined): { content: string; images: string[] } {
  if (!content) return { content: '', images: [] }
  if (typeof content === 'string') return { content, images: [] }

  const images: string[] = []
  const textParts: string[] = []

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text || '')
    } else if (block.type === 'image_url' && block.image_url?.url) {
      const base64 = extractBase64FromDataUrl(block.image_url.url)
      if (base64) images.push(base64)
    }
  }

  return { content: textParts.join(''), images }
}

function extractBase64FromDataUrl(url: string): string | null {
  const match = url.match(/^data:image\/\w+;base64,(.+)$/)
  return match?.[1] ?? null
}

function safeParseJson(str: string): any {
  try { return JSON.parse(str) } catch { return str }
}

// === Param mapping ===

function mapParams(body: ChatCompletionRequest): { options: Record<string, unknown>; format?: string | Record<string, unknown>; think?: boolean } {
  const options: Record<string, unknown> = {}
  const b = body as any

  if (body.max_tokens !== undefined) options.num_predict = body.max_tokens
  if (body.temperature !== undefined) options.temperature = body.temperature
  if (body.top_p !== undefined) options.top_p = body.top_p
  if (body.stop !== undefined) options.stop = Array.isArray(body.stop) ? body.stop : [body.stop]
  if (b.frequency_penalty !== undefined) options.repeat_penalty = b.frequency_penalty
  if (b.seed !== undefined) options.seed = b.seed
  if (b.top_k !== undefined) options.top_k = b.top_k

  let format: string | Record<string, unknown> | undefined
  const rf = body.response_format as any
  if (rf?.type === 'json_object') {
    format = 'json'
  } else if (rf?.type === 'json_schema' && rf.json_schema?.schema) {
    format = rf.json_schema.schema as Record<string, unknown>
  }

  let think: boolean | undefined
  if (b.reasoning_effort !== undefined) {
    think = b.reasoning_effort !== 'none'
  }

  return { options, format, think }
}

// === Request building ===

function buildOllamaRequest(body: ChatCompletionRequest): OllamaRequest {
  const { options, format, think } = mapParams(body)

  const ollamaBody: OllamaRequest = {
    model: body.model,
    messages: convertMessages(body.messages),
    stream: body.stream ?? false,
  }

  if (Object.keys(options).length > 0) ollamaBody.options = options
  if (format !== undefined) ollamaBody.format = format
  if (think !== undefined) ollamaBody.think = think

  // Convert tools
  if (body.tools) {
    ollamaBody.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }))
  }

  return ollamaBody
}

// === Response transformation ===

function transformOllamaResponse(ollamaRes: OllamaResponse): ChatCompletionResponse {
  const content = ollamaRes.message.content || null
  const toolCalls: ToolCall[] = []

  if (ollamaRes.message.tool_calls) {
    for (const tc of ollamaRes.message.tool_calls) {
      toolCalls.push({
        id: `call_${crypto.randomUUID().slice(0, 24)}`,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments || {}),
        },
      })
    }
  }

  const finishReason = ollamaRes.done_reason === 'stop' ? 'stop'
    : ollamaRes.done_reason === 'length' ? 'length'
    : ollamaRes.done_reason === 'tool_calls' ? 'tool_calls'
    : 'stop'

  return {
    id: `chatcmpl-ollama-${crypto.randomUUID().slice(0, 12)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: ollamaRes.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: ollamaRes.done ? finishReason : null,
    }],
    usage: {
      prompt_tokens: ollamaRes.prompt_eval_count || 0,
      completion_tokens: ollamaRes.eval_count || 0,
      total_tokens: (ollamaRes.prompt_eval_count || 0) + (ollamaRes.eval_count || 0),
    },
  }
}

// === Handler ===

export const ollamaHandler: ProviderHandler = {
  async complete(body, baseUrl) {
    const ollamaBody = buildOllamaRequest({ ...body, stream: false })
    const modelParam = ollamaBody.model

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaBody),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      throw Object.assign(new Error(`Ollama error: ${errText}`), { status: res.status })
    }

    const ollamaResponse: OllamaResponse = await res.json()
    return transformOllamaResponse(ollamaResponse)
  },

  async completeStream(body, baseUrl) {
    const ollamaBody = buildOllamaRequest({ ...body, stream: true })

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaBody),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      throw Object.assign(new Error(`Ollama error: ${errText}`), { status: res.status })
    }

    // Ollama streams NDJSON (newline-delimited JSON), not SSE
    const transformChunk = createOllamaStreamTransformer()

    return res.body!
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream<string, string>({
        transform(chunk, controller) {
          // NDJSON: each line is a complete JSON object
          const lines = chunk.split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              const data = JSON.parse(trimmed)
              const sseChunk = transformChunk(data)
              if (sseChunk) {
                controller.enqueue(`data: ${JSON.stringify(sseChunk)}\n\n`)
              }
            } catch {
              // Skip malformed lines
            }
          }
        },
      }))
  },

  async getModels() {
    try {
      const res = await fetch('http://localhost:11434/api/tags')
      if (!res.ok) return []
      const data: any = await res.json()
      return (data.models || []).map((m: any) => ({
        id: m.name,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: 'ollama',
      }))
    } catch {
      return []
    }
  },
}
