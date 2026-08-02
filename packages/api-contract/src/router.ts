import { healthContract } from './health'
import { pricesContract } from './prices'

/**
 * アプリケーションコントラクト。実際のプロシージャは機能ごとに OpenSpec の
 * 変更提案を通じて追加される — このコントラクトは `@checkin/api` が
 * 実装すべき仕様であり、クライアントがリンクする型でもある。
 */
export const contract = {
  health: healthContract,
  prices: pricesContract,
}
