import { RPCHandler } from '@orpc/server/fetch'
import { appRouter } from '@checkin/api'

const handler = new RPCHandler(appRouter)

export default defineEventHandler(async (event) => {
  const { matched, response } = await handler.handle(toWebRequest(event), {
    prefix: '/rpc',
    context: {
      // データベースハンドル・Stripe クライアントの生成とキャッシュは useDatabase /
      // useStripe を参照。ゲッターにしておくことで、実際にその依存を使うプロシージャが
      // 呼ばれたときだけ遅延生成される。db は現状どのプロシージャも参照しないが、将来の
      // ドメイン機能(会員・会計)のために Context に用意しておく。
      get db() {
        return useDatabase()
      },
      // このゲッターは参照のたびに新しい { sdk } を作る。SDK 本体は useStripe が
      // モジュールスコープでキャッシュするので、包みを作り直しても SDK は 1 つのままである。
      // 実体をインスタンス単位でキャッシュを持つものに替える場合は、参照のたびに新しい
      // インスタンスが生成されるので、包みをモジュールスコープへ持ち上げてから替えること。
      get stripe() {
        return { sdk: useStripe() }
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
