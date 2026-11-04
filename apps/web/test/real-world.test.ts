import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REAL_WORLD_APPS } from '../lib/real-world'

describe('real-world runs', () => {
  it('has a published report for every app', () => {
    for (const app of REAL_WORLD_APPS) expect(existsSync(new URL(`../public/real-world/${app.file}`, import.meta.url))).toBe(true)
  })

  it('uses only the three assessments, and records the tool honestly', () => {
    for (const app of REAL_WORLD_APPS) {
      expect(['likely leak', 'intended sharing', 'needs review']).toContain(app.assessment)
      expect(app.aiTool).toBe('not recorded')
      expect(app.prompt).toBe('not recorded')
    }
  })
})
