import type { ProviderHandler } from './base'
import type { ChatCompletionRequest, ChatCompletionResponse } from '../types'

const OPENAI_CHAT_PATH = '/v1/chat/completions'
const OPENAI_MODELS_PATH = '/v1/models'

export const openaiHandler: ProviderHandler = {
  async complete(body, baseUrl, apiKey) {
    const res = await fetch(`${baseUrl}${OPENAI_CHAT_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await normalizeOpenAIError(res)
    return res.json()
  },

  async completeStream(body, baseUrl, apiKey) {
    const res = await fetch(`${baseUrl}${OPENAI_CHAT_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream: true }),
    })
    if (!res.ok) throw await normalizeOpenAIError(res)
    return res.body!.pipeThrough(new TextDecoderStream())
  },

  async getModels(baseUrl, apiKey) {
    const res = await fetch(`${baseUrl}${OPENAI_MODELS_PATH}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    const data = await res.json()
    return data.data
  },
}

async function normalizeOpenAIError(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
  throw Object.assign(new Error(body.error?.message || res.statusText), { status: res.status })
}
