import { checkoutRouter } from './checkout'
import { invoicesRouter } from './invoices'
import { pub } from './orpc'
import { pricesRouter } from './prices'
import { productsRouter } from './products'

/**
 * アプリケーションルーター — `@checkin/api-contract` を実装する。
 *
 * プロシージャは機能ごとに OpenSpec の変更提案を通じて追加される。
 * プロシージャは機能(capability)単位でグループ化しておくこと。
 */
export const appRouter = pub.router({
  health: {
    check: pub.health.check.handler(() => ({ ok: true, timestamp: new Date().toISOString() })),
  },
  prices: pricesRouter,
  products: productsRouter,
  invoices: invoicesRouter,
  checkout: checkoutRouter,
})
