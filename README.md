# litellm-proxy

A **lightweight TypeScript port of [LiteLLM](https://github.com/BerriAI/litellm)** — the popular Python LLM gateway.

> [LiteLLM](https://github.com/BerriAI/litellm) is a Python SDK + proxy server that maps 100+ LLM APIs onto the OpenAI format. This project is a **minimal, single-binary** reimplementation of the proxy's core idea: **one OpenAI-compatible endpoint, many providers, zero client changes.** It keeps the same mental model (route by model name → translate or pass through) but in ~a few thousand lines of TypeScript instead of the full Python stack.

An OpenAI-compatible API gateway built with **[Bun](https://bun.sh)** and **[Hono](https://hono.dev)**. Point any OpenAI SDK at it and route requests to Anthropic, OpenAI, Google Gemini, Azure, Ollama, Groq, and 15+ other OpenAI-compatible providers — with automatic request/response format translation for the providers that need it.

```
your OpenAI SDK  ──►  litellm-proxy (Bun + Hono)  ──►  Anthropic / OpenAI / Gemini / Azure / Ollama / Groq / ...
                        ▲
                  same OpenAI API your code already uses
```

> 📊 Architecture diagram: [`ARCHITECTURE.mmd`](./ARCHITECTURE.mmd) (Mermaid)

---

## Why this instead of LiteLLM?

| | LiteLLM (Python) | litellm-proxy (this repo) |
|---|---|---|
| Language | Python | TypeScript (Bun runtime) |
| Scope | 100+ providers, budgeting, virtual keys, guardrails, UI | Core gateway: routing + translation + failover |
| Footprint | Python + deps, Redis, Postgres (for full features) | Single binary, SQLite (built into Bun) |
| Best for | Teams needing the full platform | Personal use / embedded gateway with minimal deps |

Use this when you want the *LiteLLM routing concept* without the Python dependency tree — e.g. a small self-hosted gateway, an embedded proxy inside a TS app, or a learning reference for how provider translation works.

---

## Features

- **One OpenAI-compatible endpoint** — `/v1/chat/completions` works with the official OpenAI SDK and any compatible client. No client code changes.
- **Provider routing by model name** — regex-based routing table (`src/config.ts`). `claude-*` → Anthropic, `gpt-*` → OpenAI, `gemini-*` → Google, `azure/...` → Azure, `ollama/...` → Ollama, and so on.
- **Format translation where needed** — Anthropic, Google Gemini, Azure, and Ollama use *dedicated handlers* that translate messages, tool calls, and streaming between their native API and the OpenAI shape. OpenAI-compatible providers (Groq, Together, Mistral, xAI, DeepSeek, etc.) are passed through as-is.
- **Automatic failover** — if a provider returns 429/5xx, it's put on a 30s SQLite cooldown and the request is retried against the next model in the fallback chain (`src/router.ts`).
- **Built-in metrics** — every request is logged to SQLite (`provider_cooldowns`, `request_log`) with per-provider success/error/latency aggregation over the last hour (`getMetrics()`).
- **Security hardening** — 1 MB body-size limit (DoS prevention), error-message sanitization that strips leaked API-key fragments, and optional proxy-level bearer auth (`PROXY_API_KEY`).
- **Single-binary deploy** — `bun build --compile` produces a standalone executable with no installed runtime. Docker image also provided.

---

## Quick Start

```bash
bun install
bun run dev
```

The server listens on `PORT` (default `3000`).

---

## Usage

Send requests exactly as you would to OpenAI — just set the `model` to the provider-prefixed name and use your **upstream provider key** in the `Authorization` header.

```bash
# Anthropic (full translation: messages, tools, streaming)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $ANTHROPIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Hello"}],"max_tokens":100}'

# OpenAI (passthrough)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

List models:

```bash
curl http://localhost:3000/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"
```

---

## Supported Providers

Routing is determined by the `model` string prefix (first match wins). Translation providers rewrite the request/response; passthrough providers forward to an OpenAI-compatible endpoint.

| Model prefix | Provider | Mode |
|---|---|---|
| `claude-*` | Anthropic | **Translation** (messages, tools, streaming) |
| `gemini-*` | Google Gemini | **Translation** (messages, tools, streaming) |
| `azure/*` | Azure OpenAI | **Translation** (`api-key` auth + deployment URL routing) |
| `ollama/*` | Ollama | **Translation** (NDJSON stream → SSE) |
| `gpt-*`, `o1-*`, `o3-*` | OpenAI | Passthrough |
| `mixtral*`, `llama*`, `gemma*` | Groq | Passthrough |
| `accounts/fireworks/models/*` | Fireworks | Passthrough |
| `meta-llama/*`, `mistralai/*`, `deepseek-ai/*` | Together | Passthrough |
| `mistral*`, `codestral*` | Mistral | Passthrough |
| `grok-*` | xAI | Passthrough |
| `deepseek-*` | DeepSeek | Passthrough |
| `Meta-Llama-*` | SambaNova | Passthrough |
| `cerebras/*` | Cerebras | Passthrough |
| `deepinfra/*` | DeepInfra | Passthrough |
| `hyperbolic/*` | Hyperbolic | Passthrough |
| `nebius/*` | Nebius | Passthrough |
| `novita/*` | Novita | Passthrough |
| `friendliai/*` | FriendliAI | Passthrough |
| `openrouter/*` | OpenRouter | Passthrough |
| `github/*` | GitHub Models | Passthrough |
| `cloudflare/*` | Cloudflare | Passthrough |
| *(anything else)* | OpenAI | Default fallback |

> Adding a provider is usually a one-file change — see `src/providers/_template.ts`.

---

## Configuration

Copy `.env.example` to `.env`:

```bash
PORT=3000                  # Server port (default 3000)
PROXY_API_KEY=             # Optional: gate access to the proxy with a static bearer key.
                           # Users still send THEIR OWN upstream provider keys downstream.
FALLBACKS=openai,anthropic,groq   # Comma-separated fallback chain (see Failover below)
```

### Failover

When a provider errors with `429`/`5xx`, it enters a 30-second cooldown and the router retries the next model in the fallback chain defined in `FALLBACK_CHAINS` (`src/router.ts`). Example: a failed `claude-*` request automatically retries `gpt-4o` → `llama-3-70b-8192`.

---

## Build & Deploy

```bash
# Development (hot reload)
bun run dev

# Type-check / lint
bun run typecheck
bun run lint

# Production binary — no runtime needed
bun run compile
./litellm-proxy

# Docker
docker build -t litellm-proxy .
docker run -p 3000:3000 litellm-proxy
```

---

## How it works

```
Client → POST /v1/chat/completions
         Auth: Bearer <user-provided upstream API key>
         Body: { "model": "claude-sonnet-4-20250514", "messages": [...] }
                  │
                  ▼ resolveProvider(model)        ← regex match in src/config.ts
                  │
        ┌─────────▼─────────┐
        │  Handler dispatch  │   anthropic/google/azure/ollama → translation
        │                    │   openai/groq/...                 → passthrough
        └─────────┬─────────┘
                  │
                  ▼ fetch(upstream API, x-api-key / Authorization: <user-key>)
                  │
        ┌─────────▼─────────┐
        │  Non-streaming?    │  Yes → parse + transformResponse
        │  No  → pipe SSE    │  No  → chunkTransform per event
        └─────────┬─────────┘
                  │
                  ▼ return OpenAI-compatible JSON / SSE stream
```

On error, the request is logged to SQLite and — if retryable — the provider is cooled down and the fallback chain is tried.

---

## Auth model & limitations

**This proxy is built for personal / single-tenant use.** Auth is **key passthrough**: the client supplies their own upstream provider key in the `Authorization` header, which is forwarded as-is. The optional `PROXY_API_KEY` is a single static gate key — it is *not* per-user identity.

Not implemented (unlike the full LiteLLM platform):

- **No multi-user / virtual keys** — there is no user table, per-user rate limiting, or quota enforcement.
- **No usage billing** — SQLite `request_log` tracks by model/provider, not by user, and stores no cost/spend.
- **No guardrails / moderation** — requests pass straight through to the provider.
- **No persistent key vault** — the proxy never stores upstream keys; the client must supply them each request.
- **Tool/streaming edge cases** — e.g. Anthropic `stream_options: { include_usage: true }` is not yet forwarded; stop-sequence count is not pre-validated against Anthropic's max-4 limit.

---

## Project layout

```
src/
  index.ts            Hono app, /v1/chat/completions + /v1/models
  config.ts           MODEL_ROUTES routing table + resolveProvider()
  router.ts           Failover chain, cooldowns, retry logic
  db.ts               SQLite cooldowns + request metrics
  security.ts         Body-size limit + error sanitization
  startup.ts          .env auto-load + provider-detection banner
  types.ts            OpenAI-compatible request/response types
  providers/
    base.ts           ProviderHandler interface
    openai.ts         Passthrough handler (shared by OpenAI-compatible providers)
    anthropic.ts      Full translation handler
    google.ts         Full translation handler (Gemini)
    azure.ts          api-key auth + deployment URL routing
    ollama.ts         NDJSON → SSE translation
    _template.ts      Starter for adding a new provider
  streaming/
    sse-parser.ts     SSE event parser
    anthropic.ts      Anthropic chunk → OpenAI chunk transform
    ollama.ts         Ollama stream → OpenAI SSE transform
```

---

## License

MIT
