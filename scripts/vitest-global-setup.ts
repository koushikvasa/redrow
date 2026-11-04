/**
 * Runs once before each package's tests, ahead of the test workers, which inherit this
 * environment. Vitest hides console output from a skipped suite, so the skip is announced
 * from here, where it can't be missed.
 */
function loadRootEnvFile(): void {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url))
  } catch (error: unknown) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    if (!missing) throw error
  }
}

export default function setup(): void {
  loadRootEnvFile()
  if (process.env.REDROW_TEST_DB_URL === undefined) {
    process.stderr.write(
      '\nREDROW_TEST_DB_URL is not set: the rollback safety and integration tests are SKIPPED.\n' +
        'Point it at a disposable Supabase database to run them.\n\n',
    )
  }
}
