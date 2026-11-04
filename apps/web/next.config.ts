import type { NextConfig } from 'next'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseSocket = supabaseUrl.replace(/^https:/, 'wss:')

// The page shows strings from scanned databases, so the browser enforces what it may load.
// Next's own inline scripts need 'unsafe-inline' without a per-request nonce.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  `connect-src 'self' ${supabaseUrl} ${supabaseSocket}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

const config: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: import.meta.dirname },
  async headers() {
    if (process.env.NODE_ENV !== 'production') return []
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default config
