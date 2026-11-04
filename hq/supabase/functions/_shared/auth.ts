/** Compares every byte, so the response time doesn't reveal how much of a secret was right. */
export function safeEqual(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let difference = a.length ^ b.length
  for (let i = 0; i < b.length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] as number)
  return expected.length > 0 && difference === 0
}

export function bearerToken(header: string | null): string {
  const match = /^Bearer (.+)$/.exec(header ?? '')
  return match?.[1] ?? ''
}

export const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
