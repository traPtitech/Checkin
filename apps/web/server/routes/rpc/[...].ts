import { RPCHandler } from '@orpc/server/fetch'
import { appRouter } from '@checkin/api'

const handler = new RPCHandler(appRouter)

export default defineEventHandler(async (event) => {
  const { matched, response } = await handler.handle(toWebRequest(event), {
    prefix: '/rpc',
    context: {
      // mysql2 のプールは初回利用時に1つだけ作成され、サーバーインスタンス
      // ごとにキャッシュされる(useDatabase 参照)。プール自体の接続は遅延する。
      // なお oRPC はリクエストのたびに context.db を参照するため、
      // health.check のような DB 不要なプロシージャでも DATABASE_URL の設定が
      // 必須になる — このゲッターは生成を遅延させるだけで、プロシージャ
      // ごとの条件分岐は行わない。
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
