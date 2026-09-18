import { implement, ORPCError } from '@orpc/server'
import type { Database } from '@checkin/db'
import { contract } from '@checkin/api-contract'
import type { AuthConfig } from './auth/config'
import type { Mailer } from './auth/mailer'
import type { SessionIdentity } from './auth/session'
import type { AuthHelpers } from './auth/context'
import type { BillingConfig } from './billing/config'
import type { StripeClient } from './stripe/client'
import type { JomonClient } from './jomon/types'
import type { JomonConfig } from './jomon/config'
import type { Notifier } from './notify/notifier'

/**
 * 全プロシージャで共有されるリクエストコンテキスト。Nitro のハンドラが
 * リクエストごとにこれを構築する(データベースハンドル、解決済みの認証設定と請求設定、
 * メーラーと会計担当への通知、遅延生成される Stripe アダプタ、
 * セッション Cookie から解決した認証済みセッション、CSRF を考慮した認可ヘルパの注入)。
 */
export interface Context extends AuthHelpers {
  db: Database
  config: AuthConfig
  billing: BillingConfig
  mailer: Mailer
  notifier: Notifier
  /** 遅延生成される Stripe アダプタ — プロシージャが実際に使うときにだけ SDK を生成する。 */
  stripe: StripeClient
  /** Jomon クライアント(pull アダプタ)。既定は `stub` で、実際に通信するドライバは環境変数で有効化する。 */
  jomon: JomonClient
  /** 解決済みの Jomon 設定(既定の支払通貨を持つ)。 */
  jomonConfig: JomonConfig
  /** 解決済みの二重の識別(traQ 会員 / isct ユーザー / 管理者)、または null。 */
  session: SessionIdentity | null
  /** 変更系(作成・更新)を許可するか。方針は project.md、機構は assertMutationsEnabled を参照。 */
  mutationsEnabled: boolean
}

/** 実装のベース — 全てのプロシージャはここから開始する。`contract` を強制する。 */
export const pub = implement(contract).$context<Context>()

/**
 * 認証済みプロシージャのビルダー。認証の検査は oRPC のミドルウェアとして走るので、
 * `.input()` の検証より前に実行される。認証されていない呼び出し元が不正な入力を
 * 送った場合に返るのは UNAUTHORIZED であって、期待される入力の形を漏らす zod の
 * BAD_REQUEST ではない。(session spec: §認可ヘルパ)
 */
export const userProc = pub.use(({ context, next }) => {
  context.requireUser()
  return next()
})

/**
 * 管理者(会計担当)プロシージャのビルダー。{@link userProc} と同様に、
 * `requireAdmin()` の検査は入力検証より前にミドルウェアとして走る。
 */
export const adminProc = pub.use(({ context, next }) => {
  context.requireAdmin()
  return next()
})

/**
 * 変更系プロシージャの実行前ガード。mutationsEnabled が false の環境では作成・更新を
 * 拒否する。無認証で決済系の書き込み(Invoice の確定、価格・商品の変更)が実行される
 * のを防ぐための暫定措置で、#15 で本来の認可チェックに置き換える。
 */
export function assertMutationsEnabled(context: Context): void {
  if (!context.mutationsEnabled) {
    throw new ORPCError('FORBIDDEN', {
      message: '変更系の操作は認可の導入まで無効化されています',
    })
  }
}
