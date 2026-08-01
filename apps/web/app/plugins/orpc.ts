import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import { contract } from '@checkin/api-contract'

export default defineNuxtPlugin(() => {
  // Resolve an absolute origin so the link works during SSR too.
  const origin = import.meta.server ? useRequestURL().origin : window.location.origin

  const link = new RPCLink({
    url: `${origin}/rpc`,
  })

  // Typed against the contract, not `@checkin/api`, so the client bundle
  // never pulls in server-only implementation code (DB driver, handlers).
  const client: ContractRouterClient<typeof contract> = createORPCClient(link)

  return {
    provide: {
      orpc: client,
    },
  }
})
