import { oc } from '@orpc/contract'
import { z } from 'zod'

/**
 * 呼び出し元自身の二重身元。member = traQ 認証済み、admin = 会計担当者、
 * hasUser = 課金対象の isct ユーザーが紐づいている。
 *
 * traqId を公開面に載せている。project.md の「規約」節は traq_id を出力しない方針を
 * 持つが、その禁止の理由は決済 API のレスポンスで customer ID と traq_id の対応が
 * 露出することと、消費者が無いことの 2 つで、この View はどちらにも当たらない。
 * customer ID を含まず、呼び出し元自身の traqId を呼び出し元だけに返す。消費者は
 * ヘッダーの会計担当者表示とトップページのログイン表示である。
 */
const authMeView = z.object({
  authenticated: z.boolean(),
  member: z.boolean(),
  admin: z.boolean(),
  hasUser: z.boolean(),
  traqId: z.string().nullable(),
})

export const authContract = {
  // isct メールアドレス宛にマジックリンクを送る。メール送信だけを行い、Cookie は設定しない
  // (Cookie を扱う経路は Nitro のルートに置く)。redirect は遷移先の指定で、
  // サーバー側で自サイト内に限定してから使う。
  requestEmailVerification: oc
    .input(
      z.object({
        email: z.email(),
        redirect: z.string().optional(),
      }),
    )
    // 送信できたことだけを表す。失敗は ORPCError で返るので、false を取る余地はない。
    .output(z.object({ ok: z.literal(true) })),

  // 現在のセッションの身元を返す。未ログインでも呼べる。
  me: oc.output(authMeView),
}
