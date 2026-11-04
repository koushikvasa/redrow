import Link from 'next/link'
import type { BackendScore } from '@/lib/queries'
import { LockIcon } from './lock-icon'

const itemClass = 'flex items-center gap-2'
const lockClass = 'text-dim'

/** The backend score is read live, so this can't go on claiming 100 if it ever stops being true. */
export function TrustRow({ backend }: { readonly backend: BackendScore | null }) {
  const sodabase = process.env.NEXT_PUBLIC_SODABASE_SCORE
  return (
    <ul className="mt-6 flex flex-wrap gap-x-8 gap-y-2 border-y border-line py-2.5 text-sm text-soft">
      <li className={itemClass}>
        <LockIcon isOpen={false} className={lockClass} />
        Every attack is rolled back
      </li>
      <li className={itemClass}>
        <LockIcon isOpen={false} className={lockClass} />
        Counts only, never your data
      </li>
      {backend === null ? null : (
        <li className={itemClass}>
          <LockIcon isOpen={false} className={lockClass} />
          <Link href={`/p/${backend.id}`} className="underline decoration-line-strong underline-offset-4 hover:decoration-ink">
            Our own backend: {backend.score}/100
          </Link>
        </li>
      )}
      {sodabase ? (
        <li className={itemClass}>
          <LockIcon isOpen={false} className={lockClass} />
          Sodabase Data Quality: {sodabase}
        </li>
      ) : null}
    </ul>
  )
}
