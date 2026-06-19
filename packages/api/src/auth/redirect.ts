/**
 * Sanitize a post-login `redirect` target to a same-site path, preventing open
 * redirects. Only same-origin absolute-path URLs (starting with a single `/`)
 * are allowed; anything else falls back to `fallback`.
 *
 * Rejected: external URLs, protocol-relative `//evil.com`, and backslash tricks.
 */
export function sanitizeRedirect(redirect: string | null | undefined, fallback = '/'): string {
  if (!redirect) {
    return fallback
  }
  // Must be an absolute path on this site, not a protocol-relative or external URL.
  if (!redirect.startsWith('/') || redirect.startsWith('//') || redirect.startsWith('/\\')) {
    return fallback
  }
  // Defense in depth: reject anything that still parses as having a host.
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
