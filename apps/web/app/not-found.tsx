import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="py-16">
      <h1 className="text-3xl font-bold">No such project.</h1>
      <Link href="/" className="mt-4 inline-block text-dim hover:text-ink">
        ← All projects
      </Link>
    </main>
  )
}
