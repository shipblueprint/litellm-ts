export interface ProviderRoute {
  pattern: RegExp
  name: string
  baseUrl: string
}

// Routes ordered by specificity — first match wins.
// Passthrough providers use openaiHandler (OpenAI-compatible API).
// Translation providers (anthropic, google) have dedicated handlers.
export const MODEL_ROUTES: ProviderRoute[] = [
  // === Translation providers (different API format) ===
  { pattern: /^claude/,                                name: 'anthropic',  baseUrl: 'https://api.anthropic.com' },
  { pattern: /^gemini/,                                name: 'google',     baseUrl: 'https://generativelanguage.googleapis.com' },
  { pattern: /^azure\//,                               name: 'azure',      baseUrl: '' }, // AZURE_API_BASE env var or body.azure_endpoint
  { pattern: /^ollama\//,                              name: 'ollama',     baseUrl: 'http://localhost:11434/v1' },

  // === OpenAI-compatible (passthrough) — specific providers first ===
  { pattern: /^gpt-/,                                  name: 'openai',     baseUrl: 'https://api.openai.com' },
  { pattern: /^o[1-9]/,                                name: 'openai',     baseUrl: 'https://api.openai.com' },

  { pattern: /^accounts\/fireworks\/models\//,          name: 'fireworks',  baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { pattern: /^meta-llama\/|^mistralai\/|^deepseek-ai\//, name: 'together', baseUrl: 'https://api.together.xyz/v1' },

  { pattern: /^codestral/,                             name: 'mistral',    baseUrl: 'https://api.mistral.ai/v1' },
  { pattern: /^mistral/,                               name: 'mistral',    baseUrl: 'https://api.mistral.ai/v1' },
  { pattern: /^grok-/,                                 name: 'xai',        baseUrl: 'https://api.x.ai/v1' },
  { pattern: /^deepseek-/,                             name: 'deepseek',   baseUrl: 'https://api.deepseek.com/v1' },

  { pattern: /^Meta-Llama-/,                           name: 'sambanova',  baseUrl: 'https://api.sambanova.ai/v1' },
  { pattern: /^cerebras\//,                            name: 'cerebras',   baseUrl: 'https://api.cerebras.ai/v1' },
  { pattern: /^deepinfra\//,                           name: 'deepinfra',  baseUrl: 'https://api.deepinfra.com/v1/openai' },
  { pattern: /^hyperbolic\//,                          name: 'hyperbolic', baseUrl: 'https://api.hyperbolic.xyz/v1' },
  { pattern: /^nebius\//,                              name: 'nebius',     baseUrl: 'https://api.studio.nebius.com/v1' },
  { pattern: /^novita\//,                              name: 'novita',     baseUrl: 'https://api.novita.ai/v3/openai' },
  { pattern: /^friendliai\//,                          name: 'friendliai', baseUrl: 'https://inference.friendli.ai/v1' },
  { pattern: /^openrouter\//,                          name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { pattern: /^github\//,                              name: 'github',     baseUrl: 'https://models.inference.ai.azure.com' },
  { pattern: /^cloudflare\//,                          name: 'cloudflare', baseUrl: 'https://api.cloudflare.com/client/v4' },

  // Groq: mixtral, llama, deepseek, gemma, etc.
  { pattern: /^mixtral|^llama|^gemma/,                 name: 'groq',       baseUrl: 'https://api.groq.com/openai/v1' },

  // Default fallback — assume OpenAI-compatible
  { pattern: /./,                                      name: 'openai',     baseUrl: 'https://api.openai.com' },
]

export function resolveProvider(model: string): ProviderRoute {
  const route = MODEL_ROUTES.find(r => r.pattern.test(model))
  if (!route) throw new Error(`No provider found for model: ${model}`)
  return route
}

export const config = {
  port: parseInt(Bun.env.PORT || '3000'),
  proxyApiKey: Bun.env.PROXY_API_KEY, // optional proxy-level auth
}
