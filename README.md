# LiteLLM Proxy (Bun)

An OpenAI-compatible API proxy built with Bun and Hono. Routes requests to multiple LLM providers (Anthropic, OpenAI, Groq) with automatic format translation.

## Quick Start

```bash
bun install
bun run dev
```

## Usage

```bash
# Non-streaming
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Hello"}],"max_tokens":100}'

# Streaming
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Supported Models

| Prefix | Provider | Notes |
|---|---|---|
| `claude-*` | Anthropic | Full translation (messages, tools, streaming) |
| `gpt-*` | OpenAI | Passthrough |
| `o1-*`, `o3-*` | OpenAI | Passthrough |
| `gemini-*` | Google | **Not implemented** — route exists but no handler |
| `mixtral-*`, `llama-*`, `deepseek-*` | Groq | OpenAI-compatible passthrough |
| (anything else) | OpenAI | Default fallback |

## Configuration

Copy `.env.example` to `.env`:

```bash
PORT=3000                    # Server port
PROXY_API_KEY=               # Optional: gate access to the proxy
```

## Build & Deploy

```bash
# Development
bun run dev

# Production binary (no runtime needed)
bun run compile
./litellm-proxy

# Docker
docker build -t litellm-proxy .
docker run -p 3000:3000 litellm-proxy
```

---

## Known Limitations & Future Work

### Multi-User Support (Not Implemented)

This proxy is designed for **personal use only**. The current auth model is "key passthrough" — each client sends their own upstream API key, which gets forwarded to the provider as-is. There is no user management.

**If you want to add multi-user support, here are the concerns:**

1. **No user identity** — The proxy has no concept of "users". It cannot distinguish who is making a request. The optional `PROXY_API_KEY` is a single static gate key, not a per-user credential.

2. **No per-user rate limiting** — A single abusive client can exhaust upstream quotas for everyone. You'd need a users table, per-user key validation, and rate limiting middleware (e.g., token bucket per user).

3. **No per-user usage tracking** — The SQLite `request_log` tracks by model/provider but not by user. You can't answer "how much did user X spend?" without adding a `user` column and logging it from the middleware.

4. **No upstream key rotation** — Each user must bring their own API key. If you want the proxy to own the keys, you need key vault, rotation logic, and per-user quota enforcement.

5. **No audit logging** — Request logs don't include who made the request. For multi-user, you'd want to log user ID, IP, request body hash, and response status.

6. **No input sanitization** — No validation of message format beyond basic JSON parsing. Malformed tool calls or image URLs could cause upstream errors.

7. **No request body size limit** — No middleware to cap request body size.

**To implement multi-user, you would add:**
- `users` table: `id`, `api_key_hash`, `rate_limit`, `quota`, `created_at`
- Authentication middleware that hashes the incoming key and looks up the user
- Per-user rate limiting (e.g., sliding window counter in SQLite)
- Usage logging with user ID foreign key
- An admin API for user management

### Other Missing Pieces

- **Google Gemini** — Route exists in config but no handler. Gemini is NOT OpenAI-compatible; needs full message/response translation like Anthropic.
- **Azure OpenAI** — Different auth (OAuth / `api-key` header), different URL format. ~4h to implement.
- **Cohere** — Different message format, different streaming. ~6h.
- **Mistral** — Mostly OpenAI-compatible but some param differences. ~2h.
- **Anthropic `stream_options`** — OpenAI clients can send `stream_options: { include_usage: true }` to get token counts in the final streaming chunk. Not yet forwarded to Anthropic.
- **`stop_sequences` limit** — Anthropic allows max 4 stop sequences; no validation before sending.

## Architecture

```
Client → POST /v1/chat/completions
         Auth: Bearer <user-provided-api-key>
         Body: { model: "claude-sonnet-4-20250514", messages: [...] }
                  │
                  ▼
           resolveProvider("claude-sonnet-4-20250514")
                  │
                  ▼ regex match /^claude/
                  │
        ┌─────────▼─────────┐
        │  AnthropicHandler  │
        │  transformRequest  │  ← Maps messages, params, tools
        │                    │     to Anthropic API format
        └─────────┬─────────┘
                  │
                  ▼ fetch(POST https://api.anthropic.com/v1/messages,
                  │         x-api-key: <user-key>)
                  │
        ┌─────────▼─────────┐
        │  Non-streaming?    │
        │  Yes → parse JSON  │
        │  No  → pipe stream │
        └─────────┬─────────┘
                  │
        ┌─────────▼─────────┐
        │  transformResponse │  ← Converts Anthropic content blocks,
        │  OR chunkTransform │     stop_reason, usage → OpenAI format
        └─────────┬─────────┘
                  │
                  ▼ return OpenAI-compatible JSON / SSE stream
```

## License

MIT
