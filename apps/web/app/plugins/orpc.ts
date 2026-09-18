import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { contract } from '@checkin/api-contract'

const CSRF_COOKIE = '__Host-checkin_csrf'

/** Read the (non-HttpOnly) CSRF cookie value on the client. */
function readCsrfCookie(): string | undefined {
  const hit = document.cookie.split('; ').find(c => c.startsWith(`${CSRF_COOKIE}=`))
  return hit ? decodeURIComponent(hit.slice(CSRF_COOKIE.length + 1)) : undefined
}

let csrfInflight: Promise<unknown> | null = null

/** Ensure a CSRF cookie exists (fetching GET /csrf once if needed) and return its value. */
async function ensureCsrfToken(): Promise<string | undefined> {
  let token = readCsrfCookie()
  if (!token) {
    csrfInflight ??= fetch('/csrf', { credentials: 'same-origin' }).finally(() => {
      csrfInflight = null
    })
    await csrfInflight
    token = readCsrfCookie()
  }
  return token
}

export default defineNuxtPlugin(() => {
  // SSR時にもリンクが機能するよう、絶対オリジンを解決する。
  const origin = import.meta.server ? useRequestURL().origin : window.location.origin

  // During SSR the link calls our own /rpc over HTTP; forward the incoming
  // cookies (captured at setup) so the session is visible while rendering.
  const ssrCookie = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  const link = new RPCLink({
    url: `${origin}/rpc`,
    // Dynamic headers per request: forward cookies on SSR; on the client attach
    // the double-submit CSRF token so state-changing procedures pass assertCsrf().
    headers: async () => {
      if (import.meta.server) {
        return ssrCookie ?? {}
      }
      const token = await ensureCsrfToken()
      return token ? { 'x-csrf-token': token } : {}
    },
  })

  // クライアントバンドルにサーバー専用の実装コード(DB ドライバ、ハンドラ)が
  // 混入しないよう、`@checkin/api` ではなくコントラクトに対して型付けする。
  const client: ContractRouterClient<typeof contract> = createORPCClient(link)

  return {
    provide: {
      orpc: client,
    },
  }
})
