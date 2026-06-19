import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterClient } from '@orpc/server'
import type { AppRouter } from '@checkin/api'

export default defineNuxtPlugin(() => {
  // Resolve an absolute origin so the link works during SSR too.
  const origin = import.meta.server ? useRequestURL().origin : window.location.origin

  const link = new RPCLink({
    url: `${origin}/rpc`,
  })

  const client: RouterClient<AppRouter> = createORPCClient(link)

  return {
    provide: {
      orpc: client,
    },
  }
})
