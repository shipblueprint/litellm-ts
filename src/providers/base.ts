import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from '../types'

export interface ProviderHandler {
  complete(body: ChatCompletionRequest, baseUrl: string, apiKey: string): Promise<ChatCompletionResponse>
  completeStream(body: ChatCompletionRequest, baseUrl: string, apiKey: string): Promise<ReadableStream<string>>
  getModels(baseUrl: string, apiKey: string): Promise<{ id: string; object: string; created: number; owned_by: string }[]>
}
