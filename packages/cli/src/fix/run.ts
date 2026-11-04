import { inRolledBackTx } from '@redrow/engine'
import type { Sql, TransactionSql } from 'postgres'

/**
 * Sends one statement at a time over the extended protocol, by asking for `simple: false`.
 * That protocol refuses more than one command per message, so even a mistake in our own
 * statement splitting couldn't smuggle a second statement, such as a COMMIT, through.
 */
async function runEach(tx: TransactionSql, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    await tx.unsafe(statement, [], { simple: false } as never)
  }
}

/** Runs the statements for real, and always rolls them back. */
export async function validateStatements(sql: Sql, statements: readonly string[]): Promise<void> {
  await inRolledBackTx(sql, (tx) => runEach(tx, statements))
}

/** Runs the statements in one transaction and commits: all of them apply, or none do. */
export async function applyStatements(sql: Sql, statements: readonly string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`set local lock_timeout = '5s'`
    await runEach(tx, statements)
  })
}
