// Runs SQL files against DEMO_DB_URL with the postgres driver, so Windows users don't need psql.
// Usage: node demo-target/scripts/apply.mjs <file.sql> [more.sql ...]
import { readFileSync } from 'node:fs'
import { connectToDemoDb, main } from './db.mjs'

await main(async () => {
  const files = process.argv.slice(2)
  if (files.length === 0) throw new Error('Usage: apply.mjs <file.sql> [more.sql ...]')
  const sql = await connectToDemoDb()
  try {
    // One transaction across all files, so a failure can't leave the schema half built.
    await sql.begin(async (tx) => {
      for (const file of files) {
        await tx.unsafe(readFileSync(file, 'utf8'))
        process.stdout.write(`Applied ${file}\n`)
      }
    })
  } finally {
    await sql.end({ timeout: 5 })
  }
})
