import { checkoutContract } from './checkout'
import { healthContract } from './health'
import { invoicesContract } from './invoices'
import { pricesContract } from './prices'
import { productsContract } from './products'

/**
 * アプリケーションコントラクト。実際のプロシージャは機能ごとに OpenSpec の
 * 変更提案を通じて追加される — このコントラクトは `@checkin/api` が
 * 実装すべき仕様であり、クライアントがリンクする型でもある。
 */
export const contract = {
  health: healthContract,
  prices: pricesContract,
  products: productsContract,
  invoices: invoicesContract,
  checkout: checkoutContract,
}
