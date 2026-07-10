export interface SSEEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/**
 * Creates a TransformStream that splits incoming text into SSE events.
 *
 * FIXED: The original plan assumed each transform() call receives one complete
 * line. In reality, TextDecoderStream outputs chunks that don't align with
 * line boundaries — a single TCP chunk can contain partial lines or multiple
 * lines. This implementation properly buffers and splits on \n.
 *
 * Handles:
 *   - Partial chunks (buffered until \n boundary)
 *   - Multiple lines in one chunk
 *   - Multiple events in one chunk (split on blank line)
 *   - Keepalive pings (empty lines)
 *   - Custom event types (event: <type>)
 *   - [DONE] sentinel
 */
export function createSSEParser(): TransformStream<string, SSEEvent> {
  let lineBuffer = ''
  let currentEvent: Partial<SSEEvent> = {}

  return new TransformStream({
    transform(chunk, controller) {
      // Append incoming chunk to buffer
      lineBuffer += chunk

      // Process all complete lines (delimited by \n)
      let newlineIdx: number
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).replace(/\r$/, '')
        lineBuffer = lineBuffer.slice(newlineIdx + 1)

        if (line === '') {
          // Blank line = event boundary. Flush the buffered event.
          if (currentEvent.data !== undefined) {
            controller.enqueue(currentEvent as SSEEvent)
          }
          currentEvent = {}
          continue
        }

        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') {
            if (currentEvent.data !== undefined) {
              controller.enqueue(currentEvent as SSEEvent)
            }
            currentEvent = {}
            continue
          }
          currentEvent.data = (currentEvent.data || '') + data
        } else if (line.startsWith('event: ')) {
          currentEvent.event = line.slice(7)
        } else if (line.startsWith('id: ')) {
          currentEvent.id = line.slice(4)
        } else if (line.startsWith('retry: ')) {
          currentEvent.retry = parseInt(line.slice(7), 10)
        }
        // Ignore comment lines (starting with :)
      }
    },

    flush(controller) {
      // Flush any remaining buffered event
      if (currentEvent.data !== undefined) {
        controller.enqueue(currentEvent as SSEEvent)
      }
    },
  })
}
