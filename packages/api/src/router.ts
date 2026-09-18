import { authRouter } from './auth/router'
import { checkoutRouter } from './checkout'
import { invoicesRouter } from './invoices'
import { membershipRouter } from './membership/router'
import { pub } from './orpc'
import { paymentsRouter } from './payments/router'
import { payoutsRouter } from './payouts/router'
import { pricesRouter } from './prices'
import { productsRouter } from './products'

/**
 * アプリケーションルーター — `@checkin/api-contract` を実装する。
 *
 * プロシージャは機能ごとに OpenSpec の変更提案を通じて追加される。
 * プロシージャは機能(capability)単位でグループ化しておくこと。
 *
 * このファイルは capability ごとのルーターを束ねるだけで、ハンドラは置かない。
 * キーは契約(`contract`)のトップレベルキーと同じ順に並べてある。
 */
export const appRouter = pub.router({
  prices: pricesRouter,
  products: productsRouter,
  invoices: invoicesRouter,
  checkout: checkoutRouter,
  auth: authRouter,
  membership: membershipRouter,
  payments: paymentsRouter,
  payouts: payoutsRouter,
})
