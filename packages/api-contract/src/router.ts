import { authContract } from './auth'
import { checkoutContract } from './checkout'
import { invoicesContract } from './invoices'
import { membershipContract } from './membership'
import { paymentsContract } from './payments'
import { payoutsContract } from './payouts'
import { pricesContract } from './prices'
import { productsContract } from './products'

/**
 * アプリケーションコントラクト。実際のプロシージャは機能ごとに OpenSpec の
 * 変更提案を通じて追加される — このコントラクトは `@checkin/api` が
 * 実装すべき仕様であり、クライアントがリンクする型でもある。
 *
 * ヘルスチェックはコントラクトに載せない。公開面の宣言は外部の消費者に対する約束であり、
 * 稼働確認は約束の対象ではないためである。
 */
export const contract = {
  prices: pricesContract,
  products: productsContract,
  invoices: invoicesContract,
  checkout: checkoutContract,
  auth: authContract,
  membership: membershipContract,
  payments: paymentsContract,
  payouts: payoutsContract,
}
