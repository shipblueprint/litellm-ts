/**
 * Auto-load .env file (for npm users without Bun's built-in --env-file).
 * Bun already loads .env natively, but this ensures it works when run via
 * `node dist/index.js` or `npx litellm-proxy`.
 */
export async function loadEnvFile(): Promise<void> {
  const envPath = `${import.meta.dir}/../.env`
  const file = Bun.file(envPath)

  // Bun.file is lazy — check existence
  if (!file.size) return

  const text = await file.text()
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

const PROVIDER_VARS: Record<string, { envKey: string; label: string; note?: string }> = {
  openai:     { envKey: 'OPENAI_API_KEY',     label: 'OpenAI' },
  anthropic:  { envKey: 'ANTHROPIC_API_KEY',  label: 'Anthropic' },
  google:     { envKey: 'GEMINI_API_KEY',     label: 'Google Gemini' },
  groq:       { envKey: 'GROQ_API_KEY',       label: 'Groq' },
  mistral:    { envKey: 'MISTRAL_API_KEY',     label: 'Mistral' },
  deepseek:   { envKey: 'DEEPSEEK_API_KEY',   label: 'DeepSeek' },
  xai:        { envKey: 'XAI_API_KEY',         label: 'xAI (Grok)' },
  azure:      { envKey: 'AZURE_API_KEY',       label: 'Azure OpenAI', note: 'also set AZURE_API_BASE' },
  ollama:     { envKey: 'OLLAMA_HOST',         label: 'Ollama (local)', note: 'no key needed if local' },
}

export function printStartupBanner(port: number): void {
  const env = Bun.env

  const configured: string[] = []
  const missing: string[] = []

  for (const [provider, info] of Object.entries(PROVIDER_VARS)) {
    const val = env[info.envKey]
    if (val) {
      configured.push(`  ✓ ${info.label}`)
    } else {
      missing.push(`  · ${info.label}  (${info.envKey}${info.note ? ` — ${info.note}` : ''})`)
    }
  }

  console.log('')
  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║           litellm-proxy v0.1.0                  ║')
  console.log('║  OpenAI-compatible LLM gateway — 22 providers   ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log('')
  console.log(`  Server:  http://localhost:${port}`)
  console.log('  Endpoint: POST /v1/chat/completions')
  console.log('  Models:   GET  /v1/models')
  console.log('')

  if (env.PROXY_API_KEY) {
    console.log('  🔒 Proxy auth enabled (PROXY_API_KEY set)')
    console.log('')
  }

  if (configured.length > 0) {
    console.log('  Providers configured:')
    console.log(configured.join('\n'))
    console.log('')
  }

  if (missing.length > 0) {
    console.log('  Add API keys to .env or environment:')
    console.log(missing.join('\n'))
    console.log('')
  }

  console.log('  Quick test:')
  console.log(`    curl http://localhost:${port}/v1/chat/completions \\`)
  console.log(`      -H "Authorization: Bearer $OPENAI_API_KEY" \\`)
  console.log(`      -H "Content-Type: application/json" \\`)
  console.log(`      -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'`)
  console.log('')
}
