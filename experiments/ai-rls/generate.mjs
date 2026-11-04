// Step 1: ask the model for each app's schema, once, in a fresh call with no system prompt.
// Refuses to overwrite an output, so a result can't be quietly re-rolled.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { APPS, promptFor } from './apps.mjs'

process.loadEnvFile(new URL('../../.env', import.meta.url))

const MODEL = process.env.REDROW_MODEL
const MAX_TOKENS = 16000
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function generate(app) {
  const dir = new URL(`./${app.dir}/`, import.meta.url)
  if (existsSync(new URL('output.md', dir))) throw new Error(`${app.dir}: output.md already exists`)
  mkdirSync(dir, { recursive: true })
  const prompt = promptFor(app)
  writeFileSync(new URL('prompt.txt', dir), `${prompt}\n`)
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  writeFileSync(new URL('output.md', dir), text)
  const meta = {
    requested_model: MODEL,
    response_model: response.model,
    stop_reason: response.stop_reason,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    generated_at: new Date().toISOString(),
  }
  writeFileSync(new URL('meta.json', dir), `${JSON.stringify(meta, null, 2)}\n`)
  return `${app.dir}: ${meta.response_model} stop=${meta.stop_reason} out=${meta.output_tokens} chars=${text.length}`
}

const results = await Promise.allSettled(APPS.map(generate))
for (const result of results) {
  if (result.status === 'fulfilled') console.log(result.value)
  else console.log(`FAILED: ${result.reason instanceof Anthropic.APIError ? `API ${result.reason.status}` : result.reason.message}`)
}
