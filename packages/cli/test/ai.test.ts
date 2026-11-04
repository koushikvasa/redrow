import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiError, generateWithClaude } from '../src/fix/ai'

const KEY = 'test-only-not-a-real-key'
const PROMPT = { system: 'the system text', user: 'the user text' }

const messageBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: 'text', text: 'begin;\ncommit;' }],
  ...overrides,
})

const respondWith = (status: number, body: unknown): ReturnType<typeof vi.fn> => {
  const fetchStub = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      }),
  )
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

const API_ERROR = { type: 'error', error: { type: 'some_error', message: `server said ${KEY}` } }

describe('generateWithClaude', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the text of the response', async () => {
    respondWith(200, messageBody())
    await expect(generateWithClaude(PROMPT, KEY, 'claude-sonnet-5-5')).resolves.toBe('begin;\ncommit;')
  })

  it('joins text blocks and skips anything else', async () => {
    const content = [
      { type: 'thinking', thinking: 'hm', signature: 'x' },
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]
    respondWith(200, messageBody({ content }))
    await expect(generateWithClaude(PROMPT, KEY, 'claude-sonnet-5-5')).resolves.toBe('one\ntwo')
  })

  it('sends the prompt and model, and allows server-side fallback', async () => {
    const fetchStub = respondWith(200, messageBody())
    await generateWithClaude(PROMPT, KEY, 'claude-sonnet-5-5')
    const init = fetchStub.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: 'the system text',
      messages: [{ role: 'user', content: 'the user text' }],
      fallbacks: 'default',
    })
    expect(new Headers(init.headers).get('anthropic-beta')).toContain('server-side-fallback')
  })

  it('leaves fallback out for a model it does not know, since REDROW_MODEL can be anything', async () => {
    const fetchStub = respondWith(200, messageBody())
    await generateWithClaude(PROMPT, KEY, 'some-other-model')
    const init = fetchStub.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(init.body as string)).not.toHaveProperty('fallbacks')
  })

  it.each([
    ['refusal', /declined/],
    ['max_tokens', /cut off/],
  ])('treats stop reason %s as a failure, not as a migration', async (stopReason, message) => {
    respondWith(200, messageBody({ stop_reason: stopReason }))
    await expect(generateWithClaude(PROMPT, KEY, 'claude-sonnet-5-5')).rejects.toThrow(message)
  })

  it.each([
    [401, /ANTHROPIC_API_KEY was rejected/],
    [403, /cannot use that model/],
    [404, /REDROW_MODEL/],
    [429, /rate limit/],
    [400, /returned an error \(400\)/],
  ])('explains an HTTP %i without repeating what the server said', async (status, message) => {
    respondWith(status, API_ERROR)
    const failure = await generateWithClaude(PROMPT, KEY, 'claude-sonnet-5-5').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AiError)
    expect((failure as AiError).message).toMatch(message)
    expect((failure as AiError).message).not.toContain(KEY)
  })

  it('explains a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))))
    await expect(generateWithClaude(PROMPT, KEY, 'claude-sonnet-5-5')).rejects.toThrow(/could not reach/)
  })
})
