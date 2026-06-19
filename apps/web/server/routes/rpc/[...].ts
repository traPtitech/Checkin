import { RPCHandler } from '@orpc/server/fetch'
import { appRouter } from '@checkin/api'

const handler = new RPCHandler(appRouter)

export default defineEventHandler(async (event) => {
  // Build the full request context: db handle + resolved auth config/mailer +
  // the session restored from the session cookie + CSRF-aware authorization
  // helpers. CSRF is enforced per-procedure via context.assertCsrf() — all oRPC
  // calls are POST so we cannot gate by HTTP method, and SSR reads such as
  // health.check / auth.me never call it.
  const context = await buildRequestContext(event)

  const { matched, response } = await handler.handle(toWebRequest(event), {
    prefix: '/rpc',
    context,
  })

  if (matched) {
    return response
  }

  setResponseStatus(event, 404, 'Not Found')
  return 'Not Found'
})
