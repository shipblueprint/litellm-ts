import type { ChatCompletionChunk } from '../types'

/**
 * Creates a per-stream Ollama → OpenAI chunk transformer.
 *
 * Ollama streams NDJSON (newline-delimited JSON), not SSE.
 * Each line is a complete JSON object with:
 *   - message.content: partial text
 *   - message.thinking: partial reasoning content
 *   - message.tool_calls: tool calls (when complete)
 *   - done: false (intermediate) or true (final)
 *   - done_reason: "stop" | "length" | "tool_calls" (only on final chunk)
 *   - prompt_eval_count, eval_count: token counts (only reliable on final)
 *
 * This transformer converts each NDJSON line into an OpenAI-compatible
 * SSE data chunk (`data: {...}\n\n`).
 */
export function createOllamaStreamTransformer() {
  let streamId = ''
  let streamModel = ''
  let initialized = false

  function makeChunk(delta: Record<string, unknown>, finishReason: string | null): ChatCompletionChunk {
    return {
      id: streamId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: streamModel,
      choices: [{ index: 0, delta: delta as any, finish_reason: finishReason }],
    }
  }

  return function transformChunk(data: any): ChatCompletionChunk | null {
    // First chunk: capture model name
    if (!initialized) {
      streamId = `chatcmpl-ollama-${crypto.randomUUID().slice(0, 12)}`
      streamModel = data.model || 'ollama'
      initialized = true

      // Emit role chunk on first message
      if (data.message) {
        const roleChunk = makeChunk({ role: 'assistant' }, null)
        // We'll return the content chunk below, but first emit role
        // Actually, we can combine role + content in the first chunk
      }
    }

    if (!data.message) return null

    const delta: Record<string, unknown> = {}
    const isFirstContent = !data.done && data.message.content

    // Role on first content chunk
    if (isFirstContent && !delta.role) {
      delta.role = 'assistant'
    }

    // Text content
    if (data.message.content) {
      delta.content = data.message.content
    }

    // Reasoning/thinking content
    if (data.message.thinking) {
      delta.reasoning_content = data.message.thinking
    }

    // Tool calls
    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      delta.tool_calls = data.message.tool_calls.map((tc: any, i: number) => ({
        index: i,
        id: `call_${crypto.randomUUID().slice(0, 24)}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments || {}),
        },
      }))
    }

    // Done chunk — emit finish_reason
    if (data.done) {
      const finishReason = data.done_reason === 'stop' ? 'stop'
        : data.done_reason === 'length' ? 'length'
        : data.done_reason === 'tool_calls' ? 'tool_calls'
        : 'stop'

      const chunk = makeChunk(
        Object.keys(delta).length > 0 ? delta : {},
        finishReason,
      )

      // Add usage on final chunk
      if (data.prompt_eval_count !== undefined || data.eval_count !== undefined) {
        chunk.usage = {
          prompt_tokens: data.prompt_eval_count || 0,
          completion_tokens: data.eval_count || 0,
          total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        }
      }

      return chunk
    }

    // Intermediate chunk — no finish_reason
    if (Object.keys(delta).length > 0) {
      return makeChunk(delta, null)
    }

    return null
  }
}
