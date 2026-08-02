import { implement } from '@orpc/server'
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
}

/** 実装のベース — 全てのプロシージャはここから開始する。`contract` を強制する。 */
export const pub = implement(contract).$context<Context>()
