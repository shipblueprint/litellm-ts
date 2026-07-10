import type { ProviderHandler } from './base'
import type { ChatCompletionRequest, ChatCompletionResponse } from '../types'

/**
 * Azure OpenAI handler.
 *
 * Key differences from standard OpenAI:
 * - Auth: `api-key` header (not `Authorization: Bearer`)
 * - URL: `{baseUrl}/openai/deployments/{deployment}/chat/completions?api-version={version}`
 * - Model name = deployment name
 * - Streaming: Same SSE format as standard OpenAI (passthrough)
 *
 * Environment variables:
 *   AZURE_API_KEY       — Azure OpenAI API key
 *   AZURE_API_VERSION   — API version (default: "2024-12-01-preview")
 */
const DEFAULT_API_VERSION = '2024-12-01-preview'

function getApiVersion(): string {
  return (Bun.env as Record<string, string | undefined>).AZURE_API_VERSION || DEFAULT_API_VERSION
}

function getAzureBaseUrl(): string {
  // Only from env var — never from client request body (SSRF prevention)
  return (Bun.env as Record<string, string | undefined>).AZURE_API_BASE || ''
}

function buildAzureUrl(baseUrl: string, deployment: string, apiVersion: string): string {
  // If baseUrl already contains /openai/deployments, use as-is with api-version
  if (baseUrl.includes('/openai/deployments')) {
    const separator = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${separator}api-version=${apiVersion}`
  }
  // Normal case: construct the full URL
  const base = baseUrl.replace(/\/$/, '')
  return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
}

function buildAzureHeaders(apiKey: string): Record<string, string> {
  return {
    'api-key': apiKey,
    'Content-Type': 'application/json',
  }
}

export const azureHandler: ProviderHandler = {
  async complete(body, _baseUrl, apiKey) {
    const baseUrl = getAzureBaseUrl()
    if (!baseUrl) throw Object.assign(new Error('Azure OpenAI: AZURE_API_BASE not configured'), { status: 400 })
    const deployment = body.model
    const apiVersion = getApiVersion()
    const url = buildAzureUrl(baseUrl, deployment, apiVersion)
    const headers = buildAzureHeaders(apiKey)

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw Object.assign(new Error(err.error?.message || 'Azure OpenAI API error'), { status: res.status })
    }

    return res.json() as Promise<ChatCompletionResponse>
  },

  async completeStream(body, _baseUrl, apiKey) {
    const baseUrl = getAzureBaseUrl()
    if (!baseUrl) throw Object.assign(new Error('Azure OpenAI: AZURE_API_BASE not configured'), { status: 400 })
    const deployment = body.model
    const apiVersion = getApiVersion()
    const url = buildAzureUrl(baseUrl, deployment, apiVersion)
    const headers = buildAzureHeaders(apiKey)

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
      throw Object.assign(new Error(err.error?.message || 'Azure OpenAI API error'), { status: res.status })
    }

    // Azure streaming SSE format is identical to standard OpenAI — passthrough
    return res.body!.pipeThrough(new TextDecoderStream())
  },

  async getModels(_baseUrl, apiKey) {
    const baseUrl = getAzureBaseUrl()
    if (!baseUrl) return []
    const apiVersion = getApiVersion()
    const base = baseUrl.replace(/\/$/, '')
    const url = `${base}/openai/models?api-version=${apiVersion}`
    const headers = buildAzureHeaders(apiKey)

    try {
      const res = await fetch(url, { headers })
      if (!res.ok) return []
      const data: any = await res.json()
      return (data.data || []).map((m: any) => ({
        id: m.id,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: 'azure',
      }))
    } catch {
      return []
    }
  },
}
