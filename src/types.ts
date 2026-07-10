// === Request ===
export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  tools?: Tool[]
  tool_choice?: ToolChoice
  stop?: string | string[]
  user?: string
  stream_options?: { include_usage?: boolean }
  response_format?: { type?: string; schema?: Record<string, unknown> }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ContentBlock {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' }
}

export interface Tool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export type ToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }

// === Response (non-streaming) ===
export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: {
    index: number
    message: {
      role: string
      content: string | null
      tool_calls?: ToolCall[]
    }
    finish_reason: string | null
  }[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: Record<string, number>
    completion_tokens_details?: Record<string, number>
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

// === Streaming chunk ===
export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: ToolCallDelta[]
    }
    finish_reason: string | null
  }[]
  usage?: ChatCompletionResponse['usage']
}

export interface ToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

// === Error ===
export interface OpenAIErrorBody {
  error: {
    message: string
    type: string
    code: string | null
    param: string | null
  }
}

// === Models ===
export interface ModelListResponse {
  object: 'list'
  data: { id: string; object: string; created: number; owned_by: string }[]
}
