import { RPCHandler } from '@orpc/server/fetch'
import { appRouter } from '@checkin/api'

const handler = new RPCHandler(appRouter)

export default defineEventHandler(async (event) => {
  const { matched, response } = await handler.handle(toWebRequest(event), {
    prefix: '/rpc',
    context: {
      // Lazy: only opens a DB connection when a procedure actually reads it.
      get db() {
        return useDatabase()
      },
    },
  })

  if (matched) {
    return response
  }

  setResponseStatus(event, 404, 'Not Found')
  return 'Not Found'
})
