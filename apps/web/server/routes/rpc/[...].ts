import { RPCHandler } from '@orpc/server/fetch'
import { appRouter } from '@checkin/api'

const handler = new RPCHandler(appRouter)

export default defineEventHandler(async (event) => {
  const { matched, response } = await handler.handle(toWebRequest(event), {
    prefix: '/rpc',
    context: {
      // データベースハンドルの生成・キャッシュ戦略は useDatabase を参照。
      // oRPC はリクエストのたびに context.db を参照するため、health.check
      // のような DB 不要なプロシージャでも DATABASE_URL の設定が必須になる
      // — このゲッターは生成を遅延させるだけで、プロシージャごとの条件分岐は行わない。
      get db() {
        return useDatabase()
      },
    },
  })

  if (matched) {
    return response
  }

  setResponseStatus(event, 404, 'Not Found')
  return '見つかりません'
})
