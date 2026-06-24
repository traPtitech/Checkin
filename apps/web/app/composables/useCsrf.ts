const CSRF_COOKIE = '__Host-checkin_csrf'

/** Read the (non-HttpOnly) CSRF cookie value on the client. */
function readCsrfCookie(): string | undefined {
  if (import.meta.server) {
    return undefined
  }
  const hit = document.cookie.split('; ').find(c => c.startsWith(`${CSRF_COOKIE}=`))
  return hit ? decodeURIComponent(hit.slice(CSRF_COOKIE.length + 1)) : undefined
}

/**
 * CSRF helper for the browser-redirect Nitro routes (`POST /logout`). Reads the
 * double-submit cookie set by `GET /csrf`, fetching it once if absent, then
 * exposes `logout()` which posts `/logout` with the `x-csrf-token` header,
 * refreshes `auth.me`, and navigates home.
 */
export function useCsrf() {
  /** Ensure a CSRF cookie exists (fetching `GET /csrf` once if needed) and return its value. */
  async function ensureCsrfToken(): Promise<string | undefined> {
    let token = readCsrfCookie()
    if (!token) {
      await $fetch('/csrf', { credentials: 'same-origin' })
      token = readCsrfCookie()
    }
    return token
  }

  /**
   * Destroy the session via `POST /logout`. Normally then refresh auth state and
   * go home. Under NeoShowcase forward-auth the server returns a `redirect` to the
   * platform logout (`/_oauth/logout`): we must follow it with a full-page
   * navigation, since the proxy's auth cookie is HttpOnly and only dropped that
   * way — clearing our session alone would leave the X-Forwarded-User identity.
   */
  async function logout(): Promise<void> {
    const token = await ensureCsrfToken()
    const res = await $fetch<{ ok: boolean, redirect?: string }>('/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: token ? { 'x-csrf-token': token } : {},
    })
    if (res?.redirect) {
      window.location.assign(res.redirect)
      return
    }
    await useAuthMe().refresh()
    await navigateTo('/')
  }

  return { ensureCsrfToken, logout }
}
