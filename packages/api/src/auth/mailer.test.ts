import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SmtpConfig } from './config'
import { createMailer, LogMailer, SmtpMailer } from './mailer'

/**
 * メール送信は nodemailer のトランスポートに委ねている。ここで固定するのは、
 * この層が担っている 4 つである。
 *
 * - log ドライバが出す 1 行。デプロイはこのドライバで動いており、traQ の bot が
 *   この行からリンクを拾って中継する(DEPLOY-NEOSHOWCASE.md)。接頭辞と 3 つの
 *   フィールドは bot が依存する取り決めなので、形を固定する。
 * - SMTP ドライバが、設定した接続先と差出人・宛先・件名・本文で送ろうとすること。
 * - 送信の失敗が呼び出し元に例外として届くこと。拒まれた宛先を載せたまま解決した
 *   送信も含む(この解決は宛先が 1 件の現在は起こらない。下のコメントを参照)。
 * - `createMailer` が設定どおりのトランスポートを選び、必要な設定が欠けていれば投げること。
 */

const SMTP: SmtpConfig = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'relay-user',
  pass: 'relay-password',
}

const MESSAGE = {
  to: 'user@isct.example',
  subject: 'Checkin: メールアドレスの確認',
  text: 'リンク: https://checkin.example/verify-email/confirm?token=t',
}

/** `sendMail` が返す info のうち、SmtpMailer が読むのは `rejected` だけである。 */
function sentInfo(rejected: string[]): { rejected: string[] } {
  return { rejected }
}

interface StubbedNodemailer {
  /** `createTransport` が受け取った引数。 */
  created: unknown[]
  /** `sendMail` が受け取った引数。 */
  sent: unknown[]
  /** 差し替えた nodemailer を読んだ mailer モジュール。 */
  module: typeof import('./mailer')
}

/**
 * nodemailer を差し替えたうえで mailer モジュールを読み直し、`createTransport` と
 * `sendMail` が受け取った引数を記録する。stripe/client.test.ts と同じ、
 * `vi.doMock` + `vi.resetModules()` + 動的 import の形。
 */
async function withStubbedNodemailer(
  sendMail: (data: unknown) => Promise<unknown>,
): Promise<StubbedNodemailer> {
  const created: unknown[] = []
  const sent: unknown[] = []
  vi.resetModules()
  vi.doMock('nodemailer', () => ({
    createTransport: (options: unknown) => {
      created.push(options)
      return {
        sendMail: (data: unknown) => {
          sent.push(data)
          return sendMail(data)
        },
      }
    },
  }))
  return { created, sent, module: await import('./mailer') }
}

afterEach(() => {
  vi.doUnmock('nodemailer')
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('LogMailer', () => {
  it('bot が拾う 1 行を、接頭辞と 3 つのフィールドのまま出す', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    await new LogMailer('noreply@checkin.example').send(MESSAGE)

    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith('[LogMailer] email (not actually sent):', {
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    })
  })

  it('メッセージを組み立てるトランスポートが失敗しても、その前に 1 行を出している', async () => {
    const stub = await withStubbedNodemailer(() => Promise.reject(new Error('build failed')))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    await expect(new stub.module.LogMailer('noreply@checkin.example').send(MESSAGE)).rejects.toThrow('build failed')

    expect(info).toHaveBeenCalledWith('[LogMailer] email (not actually sent):', {
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    })
  })

  it('送信せずメッセージを生成する JSON トランスポートを組み立てる', async () => {
    const stub = await withStubbedNodemailer(() => Promise.resolve(sentInfo([])))

    new stub.module.LogMailer('noreply@checkin.example')

    expect(stub.created).toStrictEqual([{ jsonTransport: true }])
  })
})

describe('SmtpMailer', () => {
  it('設定した接続先とユーザー名・パスワードでトランスポートを組み立てる', async () => {
    const stub = await withStubbedNodemailer(() => Promise.resolve(sentInfo([])))

    new stub.module.SmtpMailer({ ...SMTP, port: 465, secure: true }, 'noreply@checkin.example')

    expect(stub.created).toStrictEqual([{
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      auth: { user: 'relay-user', pass: 'relay-password' },
    }])
  })

  // 「渡さない」を見る比較は toStrictEqual で行う。toEqual は値が undefined の
  // プロパティを無い場合と同じに扱うため、`html: undefined` を渡す変異を捕まえない。
  it('差出人・宛先・件名・本文を渡し、html が無いときは html を渡さない', async () => {
    const stub = await withStubbedNodemailer(() => Promise.resolve(sentInfo([])))

    await new stub.module.SmtpMailer(SMTP, 'noreply@checkin.example').send(MESSAGE)

    expect(stub.sent).toStrictEqual([{
      from: 'noreply@checkin.example',
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    }])
  })

  it('html があるときは html も渡す', async () => {
    const stub = await withStubbedNodemailer(() => Promise.resolve(sentInfo([])))

    await new stub.module.SmtpMailer(SMTP, 'noreply@checkin.example').send({ ...MESSAGE, html: '<p>リンク</p>' })

    expect(stub.sent).toStrictEqual([{
      from: 'noreply@checkin.example',
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: '<p>リンク</p>',
    }])
  })

  it('トランスポートが失敗すると呼び出し元に例外が届く', async () => {
    const stub = await withStubbedNodemailer(() => Promise.reject(new Error('connect ECONNREFUSED')))

    await expect(new stub.module.SmtpMailer(SMTP, 'noreply@checkin.example').send(MESSAGE))
      .rejects.toThrow('connect ECONNREFUSED')
  })

  // この状況はスタブの中にしか無い。nodemailer の公式ドキュメント
  // (https://nodemailer.com/errors) は、解決に `rejected` が載るのは一部の宛先が
  // 拒まれて他が受理された場合であり、全宛先が拒否された場合は EENVELOPE の誤りに
  // 載せると述べている。送るメッセージは宛先が 1 件なので必ず後者に当たり、送信は
  // 解決せず棄却する(裏取りとして読んだ実装は mailer.ts の SmtpMailer.send の
  // KNOWN GAP にある)。`rejected` を載せたまま解決する送信は宛先が 2 件以上に
  // なって初めて起こるので、その日にこの分岐が担う主張を今のうちに固定しておく。
  it('拒まれた宛先を載せたまま解決した送信でも例外が届く(宛先が 2 件以上になったときの経路)', async () => {
    const stub = await withStubbedNodemailer(() => Promise.resolve(sentInfo([MESSAGE.to])))

    await expect(new stub.module.SmtpMailer(SMTP, 'noreply@checkin.example').send(MESSAGE))
      .rejects.toThrow(`SMTP send failed: the server rejected ${MESSAGE.to}`)
  })
})

describe('createMailer', () => {
  it('driver=log では LogMailer を返す', () => {
    expect(createMailer({ driver: 'log', from: 'noreply@checkin.example' })).toBeInstanceOf(LogMailer)
  })

  it('driver=log では smtp の設定が空でも成り立つ', () => {
    const mailer = createMailer({
      driver: 'log',
      from: 'noreply@checkin.example',
      smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
    })

    expect(mailer).toBeInstanceOf(LogMailer)
  })

  it('driver=smtp では SmtpMailer を返す', () => {
    expect(createMailer({ driver: 'smtp', from: 'noreply@checkin.example', smtp: SMTP })).toBeInstanceOf(SmtpMailer)
  })

  const missing: [string, SmtpConfig | undefined][] = [
    ['設定そのものが無い', undefined],
    ['host が空', { ...SMTP, host: '' }],
    ['user が空', { ...SMTP, user: '' }],
    ['pass が空', { ...SMTP, pass: '' }],
  ]
  it.each(missing)('driver=smtp で %s なら投げる', (_label, smtp) => {
    expect(() => createMailer({ driver: 'smtp', from: 'noreply@checkin.example', smtp })).toThrow(
      'SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required when MAILER_DRIVER=smtp',
    )
  })
})
