import type { ProviderHandler } from './base'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentBlock,
  Tool,
  ToolCall,
} from '../types'
import { createSSEParser, type SSEEvent } from '../streaming/sse-parser'

// === Gemini internal types ===

interface GeminiMessage {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

interface GeminiResponse {
  candidates?: {
    content: { parts: GeminiPart[]; role: string }
    finishReason: string
  }[]
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
}

// === Utility ===

function safeParseJson(str: string): any {
  try { return JSON.parse(str) } catch { return {} }
}

// === Message conversion ===

function convertOpenAIMessagesToGemini(messages: ChatMessage[]): {
  systemInstruction: string
  contents: GeminiMessage[]
} {
  let systemInstruction = ''
  const contents: GeminiMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Concatenate all system messages
      const text = typeof msg.content === 'string' ? msg.content : ''
      systemInstruction = systemInstruction ? `${systemInstruction}\n${text}` : text
      continue
    }

    if (msg.role === 'user') {
      contents.push({
        role: 'user',
        parts: convertUserParts(msg.content),
      })
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (msg.content) {
        parts.push({ text: typeof msg.content === 'string' ? msg.content : '' })
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: safeParseJson(tc.function.arguments),
            },
          })
        }
      }
      if (parts.length > 0) {
        contents.push({ role: 'model', parts })
      }
    }

    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.name || msg.tool_call_id || 'unknown',
            response: { result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
          },
        }],
      })
    }
  }

  // Gemini requires alternating user/model messages
  // Merge consecutive same-role messages
  const merged = mergeConsecutiveSameRole(contents)

  // Ensure first message is user
  const first = merged[0]
  if (first && first.role !== 'user') {
    merged.unshift({ role: 'user', parts: [{ text: 'Please continue.' }] })
  }

  return { systemInstruction, contents: merged }
}

function convertUserParts(content: string | ContentBlock[] | null): GeminiPart[] {
  if (!content) return [{ text: '' }]
  if (typeof content === 'string') return [{ text: content }]

  return content.map(block => {
    if (block.type === 'text') return { text: block.text || '' }
    if (block.type === 'image_url') {
      const { mimeType, base64Data } = parseDataUrl(block.image_url!.url)
      return { inlineData: { mimeType, data: base64Data } }
    }
    return { text: '' }
  })
}

function parseDataUrl(url: string): { mimeType: string; base64Data: string } {
  const match = url.match(/^data:(image\/\w+);base64,(.+)$/)
  if (!match || !match[1] || !match[2]) throw new Error('Invalid data URL for image')
  return { mimeType: match[1], base64Data: match[2] }
}

function mergeConsecutiveSameRole(messages: GeminiMessage[]): GeminiMessage[] {
  const merged: GeminiMessage[] = []
  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.parts = [...last.parts, ...msg.parts]
    } else {
      merged.push({ ...msg, parts: [...msg.parts] })
    }
  }
  return merged
}

// === Tool name sanitization ===

function sanitizeToolNames(tools: Tool[]): { tools: Tool[]; reverseMap: Map<string, string> } {
  const reverseMap = new Map<string, string>()

  const sanitized = tools.map(tool => {
    const original = tool.function.name
    const sanitized = original.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
    if (sanitized !== original) {
      reverseMap.set(sanitized, original)
    }
    return {
      ...tool,
      function: { ...tool.function, name: sanitized },
    }
  })

  return { tools: sanitized, reverseMap }
}

// === Request building ===

function buildGeminiRequest(body: ChatCompletionRequest): {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  const { systemInstruction, contents } = convertOpenAIMessagesToGemini(body.messages)

  const payload: Record<string, unknown> = {
    contents,
    generationConfig: {},
  }

  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] }
  }

  // Map generation params
  const genConfig = payload.generationConfig as Record<string, unknown>
  if (body.max_tokens !== undefined) genConfig.maxOutputTokens = body.max_tokens
  if (body.temperature !== undefined) genConfig.temperature = body.temperature
  if (body.top_p !== undefined) genConfig.topP = body.top_p
  if (body.stop !== undefined) {
    genConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  }

  // Map tools
  if (body.tools) {
    const { tools, reverseMap } = sanitizeToolNames(body.tools)
    payload.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }]
    if (reverseMap.size > 0) {
      ;(payload as any)._toolNameReverseMap = Object.fromEntries(reverseMap)
    }
  }

  // Map tool_choice
  if (body.tool_choice) {
    if (body.tool_choice === 'auto') {
      payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
    } else if (body.tool_choice === 'none') {
      payload.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
    } else if (body.tool_choice === 'required') {
      payload.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
    } else if (typeof body.tool_choice === 'object' && body.tool_choice.type === 'function') {
      payload.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [body.tool_choice.function.name],
        },
      }
    }
  }

  // Map response_format
  if (body.response_format?.type === 'json_object') {
    genConfig.responseMimeType = 'application/json'
  }

  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent`,
    headers: {
      'Content-Type': 'application/json',
    },
    body: payload,
  }
}

// === Response transformation ===

const FINISH_REASON_MAP: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  OTHER: 'stop',
}

function transformGeminiResponse(geminiRes: GeminiResponse, model: string, reverseToolMap?: Map<string, string>): ChatCompletionResponse {
  let content = ''
  const toolCalls: ToolCall[] = []

  const candidate = geminiRes.candidates?.[0]
  if (candidate) {
    for (const part of candidate.content.parts) {
      if ('text' in part) {
        content += part.text
      } else if ('functionCall' in part) {
        let name = part.functionCall.name
        if (reverseToolMap?.has(name)) {
          name = reverseToolMap.get(name)!
        }
        toolCalls.push({
          id: `call_${crypto.randomUUID()}`,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        })
      }
    }
  }

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: candidate ? (FINISH_REASON_MAP[candidate.finishReason] || 'stop') : 'stop',
    }],
    usage: {
      prompt_tokens: geminiRes.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: geminiRes.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: geminiRes.usageMetadata?.totalTokenCount ?? 0,
    },
  }
}

// === Streaming chunk transformation ===

function transformStreamChunk(data: any, reverseToolMap?: Map<string, string>): string | null {
  // Gemini streaming uses SSE with data: { candidates: [...] }
  const candidate = data.candidates?.[0]
  if (!candidate) return null

  const parts = candidate.content?.parts || []
  const delta: Record<string, unknown> = {}

  for (const part of parts) {
    if ('text' in part) {
      delta.content = part.text
    } else if ('functionCall' in part) {
      let name = part.functionCall.name
      if (reverseToolMap?.has(name)) {
        name = reverseToolMap.get(name)!
      }
      delta.tool_calls = [{
        index: 0,
        id: `call_${crypto.randomUUID()}`,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      }]
    }
  }

  let finishReason: string | null = null
  if (candidate.finishReason) {
    finishReason = FINISH_REASON_MAP[candidate.finishReason] || 'stop'
  }

  const chunk = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk' as const,
    created: Math.floor(Date.now() / 1000),
    model: '', // filled by caller
    choices: [{
      index: 0,
      delta: Object.keys(delta).length > 0 ? delta : {},
      finish_reason: finishReason,
    }],
  }

  return JSON.stringify(chunk)
}

// === Handler ===

export const googleHandler: ProviderHandler = {

  async complete(body, baseUrl, apiKey) {
    const request = buildGeminiRequest(body)
    // Gemini uses API key as URL param, not header
    const url = new URL(request.url)
    url.searchParams.set('key', apiKey)

    const reverseToolMap = (request.body as any)._toolNameReverseMap
      ? new Map(Object.entries((request.body as any)._toolNameReverseMap as Record<string, string>))
      : undefined
    delete (request.body as any)._toolNameReverseMap

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw Object.assign(new Error(err.error?.message || 'Gemini API error'), { status: res.status })
    }

    const geminiResponse: GeminiResponse = await res.json()
    return transformGeminiResponse(geminiResponse, body.model, reverseToolMap)
  },

  async completeStream(body, baseUrl, apiKey) {
    const request = buildGeminiRequest(body)
    // Gemini streaming uses :streamGenerateContent endpoint
    request.url = request.url.replace(':generateContent', ':streamGenerateContent?alt=sse')

    const url = new URL(request.url)
    url.searchParams.set('key', apiKey)

    const reverseToolMap = (request.body as any)._toolNameReverseMap
      ? new Map(Object.entries((request.body as any)._toolNameReverseMap as Record<string, string>))
      : undefined
    delete (request.body as any)._toolNameReverseMap

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw Object.assign(new Error(err.error?.message || 'Gemini API error'), { status: res.status })
    }

    const modelName = body.model

    return res.body!
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createSSEParser())
      .pipeThrough(new TransformStream<SSEEvent, string>({
        transform(event, controller) {
          try {
            const data = JSON.parse(event.data)
            const chunkJson = transformStreamChunk(data, reverseToolMap)
            if (chunkJson) {
              // Patch in the real model name
              const chunk = JSON.parse(chunkJson)
              chunk.model = modelName
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
      { id: 'gemini-2.5-pro', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'google' },
      { id: 'gemini-2.5-flash', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'google' },
      { id: 'gemini-2.0-flash', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'google' },
    ]
  },
}
