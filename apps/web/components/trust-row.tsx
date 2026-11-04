import Link from 'next/link'
import type { BackendScore } from '@/lib/queries'
import { LockIcon } from './lock-icon'

const itemClass = 'flex items-center gap-2'

/** The backend score is read live, so this can't go on claiming 100 if it ever stops being true. */
export function TrustRow({ backend }: { readonly backend: BackendScore | null }) {
  const sodabase = process.env.NEXT_PUBLIC_SODABASE_SCORE
  return (
    <ul className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-y border-line py-2.5 text-sm text-[#c9c8c2]">
      <li className={itemClass}>
        <LockIcon isOpen={false} className="text-ok" />
        Nothing persists, every attack is rolled back
      </li>
      <li className={itemClass}>
        <LockIcon isOpen={false} className="text-ok" />
        Counts only, never your data
      </li>
      {backend === null ? null : (
        <li className={itemClass}>
          <LockIcon isOpen={false} className="text-ok" />
          <Link href={`/p/${backend.id}`} className="underline decoration-faint underline-offset-4 hover:decoration-ink">
            Our own backend: {backend.score}/100
          </Link>
        </li>
      )}
      {sodabase ? (
        <li className={itemClass}>
          <LockIcon isOpen={false} className="text-ok" />
          Sodabase Data Quality: {sodabase}
        </li>
      ) : null}
    </ul>
  )
}
