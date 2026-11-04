import { describe, expect, test } from 'vitest'
import { THEME_KEY, parseThemeChoice, themeInitScript } from '../lib/theme'

type FakeRoot = { dataset: Record<string, string> }

/** Runs the pre-paint script against fakes, the way the browser would before hydration. */
function runInitScript(getItem: () => string | null): FakeRoot {
  const root: FakeRoot = { dataset: {} }
  new Function('localStorage', 'document', themeInitScript)({ getItem }, { documentElement: root })
  return root
}

describe('parseThemeChoice', () => {
  test('keeps an explicit light or dark choice', () => {
    expect(parseThemeChoice('light')).toBe('light')
    expect(parseThemeChoice('dark')).toBe('dark')
  })

  test('falls back to system for missing or tampered values', () => {
    expect(parseThemeChoice(null)).toBe('system')
    expect(parseThemeChoice('system')).toBe('system')
    expect(parseThemeChoice('<script>')).toBe('system')
  })
})

describe('themeInitScript', () => {
  test('applies a stored choice before first paint', () => {
    expect(runInitScript(() => 'dark').dataset.theme).toBe('dark')
    expect(runInitScript(() => 'light').dataset.theme).toBe('light')
  })

  test('leaves the attribute off for system, so the media query decides', () => {
    expect(runInitScript(() => null).dataset.theme).toBeUndefined()
    expect(runInitScript(() => 'nonsense').dataset.theme).toBeUndefined()
  })

  test('survives blocked storage', () => {
    const blocked = (): string | null => {
      throw new Error('storage is blocked')
    }
    expect(runInitScript(blocked).dataset.theme).toBeUndefined()
  })

  test('reads the same key the toggle writes', () => {
    expect(themeInitScript).toContain(THEME_KEY)
  })
})
