const inRange = (code: number, low: number, high: number): boolean => code >= low && code <= high

/**
 * C0 and C1 controls, line and paragraph separators, and the bidi controls that can make
 * displayed text differ from what it really says. Written as code points, not a regex
 * literal, because some of these characters would end a regex literal if pasted raw.
 */
const isUnsafeForTerminal = (code: number): boolean =>
  inRange(code, 0x00, 0x1f) ||
  inRange(code, 0x7f, 0x9f) ||
  code === 0x61c ||
  inRange(code, 0x200e, 0x200f) ||
  inRange(code, 0x2028, 0x202e) ||
  inRange(code, 0x2066, 0x2069)

/**
 * Table, column and policy names come from the scanned database, so they are untrusted: a
 * name can hold escape sequences that spoof a clean report or rewrite the terminal title.
 * This shows such characters instead of letting them act.
 */
export const sanitizeForTerminal = (text: string): string =>
  Array.from(text, (char) => {
    const code = char.codePointAt(0) as number
    return isUnsafeForTerminal(code) ? `\\u{${code.toString(16)}}` : char
  }).join('')

/**
 * JSON that is safe to `cat`. `JSON.stringify` already escapes C0 controls, but leaves C1
 * and bidi controls raw. The escapes are still valid JSON, so the data round-trips exactly.
 */
export const toTerminalSafeJson = (value: unknown): string =>
  Array.from(JSON.stringify(value, null, 2), (char) => {
    const code = char.codePointAt(0) as number
    const isJsonWhitespace = char === '\n'
    return isUnsafeForTerminal(code) && !isJsonWhitespace ? `\\u${code.toString(16).padStart(4, '0')}` : char
  }).join('')
