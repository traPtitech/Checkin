import { RPCHandler } from '@orpc/server/fetch'
import { appRouter } from '@checkin/api'

const handler = new RPCHandler(appRouter)

export default defineEventHandler(async (event) => {
  const { matched, response } = await handler.handle(toWebRequest(event), {
    prefix: '/rpc',
    context: {
      // データベースハンドル・Stripe クライアントの生成とキャッシュは
      // useDatabase / useStripe を参照。ゲッターにしておくことで、実際に
      // その依存を使うプロシージャが呼ばれたときだけ遅延生成される
      // (health.check のように両方不要なプロシージャでは生成されない)。
      get db() {
        return useDatabase()
      },
      get stripe() {
        return useStripe()
      },
      // 変更系ガードのフラグ。既定 false で無認証の書き込みを塞ぐ(#15 で認可に置き換え)。
      mutationsEnabled: useRuntimeConfig().enableUnsafeMutations,
    },
  })

  if (matched) {
    return response
  }

  setResponseStatus(event, 404, 'Not Found')
  return '見つかりません'
})
