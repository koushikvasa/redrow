import Anthropic from '@anthropic-ai/sdk'
import type { FixPrompt } from './prompt'

export const DEFAULT_MODEL = 'claude-sonnet-5-5'

// Enough for a large migration, and small enough to stay well under the SDK's HTTP timeout.
const MAX_TOKENS = 16000
const REQUEST_TIMEOUT_MS = 120_000

// These models can route a declined request to another model server-side. The prompt talks
// about attacks on access control, which a safety classifier could read as offensive work.
const SUPPORTS_DEFAULT_FALLBACKS: ReadonlySet<string> = new Set([
  'claude-sonnet-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
])

/** A failure whose message is safe to print: it never carries the key or response bodies. */
export class AiError extends Error {}

function explain(error: unknown): AiError {
  if (error instanceof Anthropic.AuthenticationError) return new AiError('ANTHROPIC_API_KEY was rejected')
  if (error instanceof Anthropic.PermissionDeniedError) return new AiError('this API key cannot use that model')
  if (error instanceof Anthropic.NotFoundError) return new AiError('REDROW_MODEL names a model the API does not know')
  if (error instanceof Anthropic.RateLimitError) return new AiError('the API rate limit was hit')
  if (error instanceof Anthropic.APIConnectionError) return new AiError('could not reach the API')
  if (error instanceof Anthropic.APIError) return new AiError(`the API returned an error (${error.status ?? 'no status'})`)
  return new AiError('the API call failed')
}

/** Asks Claude for a migration. The result is untrusted text: the caller must parse it. */
export async function generateWithClaude(prompt: FixPrompt, apiKey: string, model: string): Promise<string> {
  const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS })
  let response: Anthropic.Beta.BetaMessage
  try {
    response = (await client.beta.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      ...(SUPPORTS_DEFAULT_FALLBACKS.has(model)
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
        : {}),
    } as Anthropic.Beta.MessageCreateParamsNonStreaming)) as Anthropic.Beta.BetaMessage
  } catch (error: unknown) {
    throw explain(error)
  }
  if (response.stop_reason === 'refusal') throw new AiError('the model declined this request')
  if (response.stop_reason === 'max_tokens') throw new AiError('the response was cut off at the token limit')
  return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}
