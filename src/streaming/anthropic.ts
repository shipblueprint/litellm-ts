import type { ChatCompletionChunk } from '../types'

/**
 * Creates a per-stream Anthropic → OpenAI chunk transformer.
 *
 * Fixes applied vs original plan:
 * - Per-stream state via closure (no race condition)
 * - Tool index tracking (increments per tool_use block)
 * - Reverse tool name map (un-sanitize names back to original)
 * - Partial JSON accumulation (tool args arriving across multiple chunks)
 * - Empty tool call args → sends "{}" instead of empty string
 */
export function createAnthropicStreamTransformer(reverseToolMap?: Map<string, string>) {
  let streamId = ''
  let streamModel = ''
  let toolIndex = -1

  // Partial JSON accumulation for tool call arguments
  let currentBlockType: string | null = null
  let accumulatedJson = ''

  function makeChunk(delta: Record<string, unknown>, finishReason: string | null): ChatCompletionChunk {
    return {
      id: streamId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: streamModel,
      choices: [{ index: 0, delta: delta as any, finish_reason: finishReason }],
    }
  }

  function mapStopReason(reason: string): string | null {
    const map: Record<string, string> = {
      end_turn: 'stop',
      stop_sequence: 'stop',
      max_tokens: 'length',
      tool_use: 'tool_calls',
      content_filtered: 'content_filter',
    }
    return map[reason] || reason
  }

  return function transformChunk(eventType: string, data: any): ChatCompletionChunk | null {
    // First chunk: extract id + model from message_start
    if (data.type === 'message_start') {
      streamId = data.message.id
      streamModel = data.message.model
      return {
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: streamModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        usage: {
          prompt_tokens: data.message.usage.input_tokens,
          completion_tokens: 0,
          total_tokens: data.message.usage.input_tokens,
        },
      }
    }

    if (data.type === 'content_block_start') {
      currentBlockType = data.content.type
      accumulatedJson = ''

      if (data.content.type === 'text') {
        return makeChunk({ content: data.content.text }, null)
      }

      if (data.content.type === 'tool_use') {
        toolIndex++
        // Reverse-map the tool name back to caller's original
        let toolName = data.content.name
        if (reverseToolMap?.has(toolName)) {
          toolName = reverseToolMap.get(toolName)!
        }
        return makeChunk({
          tool_calls: [{
            index: toolIndex,
            id: data.content.id,
            type: 'function',
            function: { name: toolName, arguments: '' },
          }],
        }, null)
      }
    }

    if (data.type === 'content_block_delta') {
      if (data.delta.type === 'text_delta') {
        return makeChunk({ content: data.delta.text }, null)
      }

      if (data.delta.type === 'input_json_delta' && currentBlockType === 'tool_use') {
        // Accumulate partial JSON
        accumulatedJson += data.delta.partial_json
        return makeChunk({
          tool_calls: [{
            index: toolIndex,
            function: { arguments: data.delta.partial_json },
          }],
        }, null)
      }

      if (data.delta.type === 'thinking_delta') {
        return makeChunk({ reasoning_content: data.delta.thinking }, null)
      }
    }

    if (data.type === 'content_block_stop') {
      // If this was a tool_use block with empty accumulated args, send "{}"
      if (currentBlockType === 'tool_use' && accumulatedJson.trim() === '') {
        const chunk = makeChunk({
          tool_calls: [{
            index: toolIndex,
            function: { arguments: '{}' },
          }],
        }, null)
        currentBlockType = null
        accumulatedJson = ''
        return chunk
      }
      currentBlockType = null
      accumulatedJson = ''
      return null
    }

    if (data.type === 'message_delta') {
      const finishReason = mapStopReason(data.delta.stop_reason)
      const chunk = makeChunk({}, finishReason)

      if (data.usage) {
        chunk.usage = {
          prompt_tokens: 0,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.output_tokens,
        }
      }
      return chunk
    }

    if (data.type === 'error') {
      throw new Error(data.error?.message || 'Anthropic API error')
    }

    // message_stop, ping → no output
    return null
  }
}
