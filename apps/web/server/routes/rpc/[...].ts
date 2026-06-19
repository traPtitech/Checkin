import { RPCHandler } from '@orpc/server/fetch'
import { appRouter } from '@checkin/api'

const handler = new RPCHandler(appRouter)

export default defineEventHandler(async (event) => {
  const { matched, response } = await handler.handle(toWebRequest(event), {
    prefix: '/rpc',
    context: {
      // A single mysql2 pool is created on first use and cached per server
      // instance (see useDatabase); the pool itself connects lazily. Note that
      // oRPC reads context.db for *every* request, so DATABASE_URL must be set
      // even for DB-free procedures like health.check — the getter only defers
      // creation, it does not make it conditional on the procedure.
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
