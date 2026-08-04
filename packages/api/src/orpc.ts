import { implement, ORPCError } from '@orpc/server'
import type { Database } from '@checkin/db'
import type Stripe from 'stripe'
import { contract } from '@checkin/api-contract'

/**
 * 全プロシージャで共有されるリクエストコンテキスト。Nitro のハンドラが
 * リクエストごとにこれを構築する(例: データベースハンドル・Stripe クライアントの
 * 注入、認証が仕様化された後には認証済みユーザーの注入)。
 */
export interface Context {
  db: Database
  stripe: Stripe
  /**
   * 変更系(作成・更新)を許可するか。現状は全プロシージャが無認証のため、認可
   * (#15)が入るまでの暫定措置として、既定でこれを false にして変更系を塞ぐ。
   */
  mutationsEnabled: boolean
}

/** 実装のベース — 全てのプロシージャはここから開始する。`contract` を強制する。 */
export const pub = implement(contract).$context<Context>()

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
