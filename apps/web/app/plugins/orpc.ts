import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { contract } from '@checkin/api-contract'

export default defineNuxtPlugin(() => {
  // SSR時にもリンクが機能するよう、絶対オリジンを解決する。
  const origin = import.meta.server ? useRequestURL().origin : window.location.origin

  const link = new RPCLink({
    url: `${origin}/rpc`,
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
