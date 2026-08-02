import { pub } from './orpc'

/**
 * アプリケーションルーター — `@checkin/api-contract` を実装する。
 *
 * 現時点では `health.check` の疎通確認プロシージャのみ存在する。実際の
 * プロシージャは機能ごとに OpenSpec の変更提案を通じて追加される。
 * プロシージャは機能(capability)単位でグループ化しておくこと。
 */
export const appRouter = pub.router({
  health: {
    check: pub.health.check.handler(() => ({ ok: true, timestamp: new Date().toISOString() })),
  },
})
