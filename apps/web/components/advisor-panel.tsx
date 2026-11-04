import { advisorText, isAdvisorMiss, redRowText, type AdvisorComparison, type ComparisonRow } from '@/lib/advisor'
import { LockIcon } from './lock-icon'

const OPEN_LOCK = '🔓 '

/** The emoji paints its own orange on most systems, so sighted readers get the drawn lock in signal red. */
function RedRowVerdict({ text }: { readonly text: string }) {
  if (!text.startsWith(OPEN_LOCK)) return text
  return (
    <>
      <span className="sr-only">{OPEN_LOCK}</span>
      <LockIcon isOpen className="mr-1 align-[-0.1em]" />
      {text.slice(OPEN_LOCK.length)}
    </>
  )
}

function Row({ row }: { readonly row: ComparisonRow }) {
  const redRowClass = row.redRow === 'proven' ? 'whitespace-nowrap font-bold text-leak' : 'text-dim'
  const advisorClass = row.advisor === 'flagged' ? 'text-dim' : 'font-bold text-ink'
  return (
    <tr className={`border-t border-line ${isAdvisorMiss(row) ? 'bg-[var(--leak-tint)]' : ''}`}>
      <th scope="row" className="px-3 py-1.5 align-top font-normal">
        <span className="block">{row.leak}</span>
        <code className="block break-words text-[0.68rem] leading-snug text-dim">{row.policy}</code>
      </th>
      <td className={`px-2 py-1.5 align-top whitespace-nowrap ${advisorClass}`}>{advisorText(row)}</td>
      <td className={`px-3 py-1.5 align-top ${redRowClass}`}>
        <RedRowVerdict text={redRowText(row)} />
      </td>
    </tr>
  )
}

export function AdvisorPanel({ comparison }: { readonly comparison: AdvisorComparison }) {
  return (
    <section aria-labelledby="advisor-heading" className="border border-line bg-panel">
      <h2 id="advisor-heading" className="eyebrow px-3 py-2.5">
        Red Row vs Supabase Advisor
      </h2>
      <table className="w-full text-left text-xs 2xl:text-[0.8125rem]">
        <thead>
          <tr className="border-t border-line text-dim">
            <th scope="col" className="px-3 py-1.5 font-medium">
              Leak
            </th>
            <th scope="col" className="px-2 py-1.5 font-medium">
              Supabase Advisor
            </th>
            <th scope="col" className="px-3 py-1.5 font-medium">
              Red Row
            </th>
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-2 text-xs text-dim">
        Advisor run on {comparison.advisorRunOn}. Red Row doesn&apos;t check search_path or auth settings.
      </p>
    </section>
  )
}
