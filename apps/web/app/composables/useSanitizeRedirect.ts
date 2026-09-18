/**
 * Sanitize a `redirect` query to a same-site path, mirroring the server's
 * `sanitizeRedirect` (packages/api/src/auth/redirect.ts). Only same-origin
 * absolute-path URLs (a single leading `/`) survive; anything else (external,
 * protocol-relative `//`, backslash tricks) falls back. Reimplemented here so
 * the client imports only the server's *types*, never its implementation.
 */
export function sanitizeRedirect(redirect: string | null | undefined, fallback = '/'): string {
  if (!redirect) {
    return fallback
  }
  if (!redirect.startsWith('/') || redirect.startsWith('//') || redirect.startsWith('/\\')) {
    return fallback
  }
  try {
    const url = new URL(redirect, 'http://placeholder.invalid')
    if (url.origin !== 'http://placeholder.invalid') {
      return fallback
    }
    return url.pathname + url.search + url.hash
  }
  catch {
    return fallback
  }
}
