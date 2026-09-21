import { describe, expect, it } from 'vitest'
import { affectedRowCount, isDuplicateKeyError } from './mysql-result'

/**
 * `mysql-result.ts` の 2 つの読み取りは、ドライバが宣言していない形の値を読む。
 * どちらも呼び出し元が「要求した行を claim できたか」と「重複キーで弾かれたか」の
 * 判定に使い、判定を誤ると二重の予約や二重の支払いにつながる。ドライバの形が
 * 変わったときに既定へ落ちることを、形ごとに固定する。
 */

describe('affectedRowCount', () => {
  it('ResultSetHeader をそのまま渡した形を読む', () => {
    expect(affectedRowCount({ affectedRows: 3 })).toBe(3)
  })

  it('[ResultSetHeader, FieldPacket[]] のタプルの形を読む', () => {
    expect(affectedRowCount([{ affectedRows: 2 }, []])).toBe(2)
  })

  it('0 行を claim した結果を 0 として返す', () => {
    expect(affectedRowCount({ affectedRows: 0 })).toBe(0)
  })

  it('どちらの形でもないものは 0 を返す', () => {
    expect(affectedRowCount(undefined)).toBe(0)
    expect(affectedRowCount(null)).toBe(0)
    expect(affectedRowCount('1')).toBe(0)
    expect(affectedRowCount({})).toBe(0)
    expect(affectedRowCount([])).toBe(0)
  })

  it('affectedRows が数値でないものは 0 を返す', () => {
    expect(affectedRowCount({ affectedRows: '3' })).toBe(0)
    expect(affectedRowCount({ affectedRows: null })).toBe(0)
  })
})

describe('isDuplicateKeyError', () => {
  it('code と errno のどちらでも重複キーと判定する', () => {
    expect(isDuplicateKeyError({ code: 'ER_DUP_ENTRY' })).toBe(true)
    expect(isDuplicateKeyError({ errno: 1062 })).toBe(true)
  })

  it('drizzle が包んだ形を cause から見つける', () => {
    // 実測した形を写したもの。包んだ側は code も errno も持たず、1 段下の cause が
    // mysql2 のエラーである(測定した版と日付は `mysql-result.ts` のコメント)。
    expect(isDuplicateKeyError(
      new Error('Failed query: insert into `membership_slots` ...', {
        cause: Object.assign(new Error('Duplicate entry ... for key \'membership_slots_user_year_half_uq\''), {
          code: 'ER_DUP_ENTRY',
          errno: 1062,
        }),
      }),
    )).toBe(true)
  })

  it('cause の 5 段目までは見つける', () => {
    const depth5 = { cause: { cause: { cause: { cause: { errno: 1062 } } } } }
    expect(isDuplicateKeyError(depth5)).toBe(true)
  })

  it('cause の 6 段目は見ない', () => {
    const depth6 = { cause: { cause: { cause: { cause: { cause: { errno: 1062 } } } } } }
    expect(isDuplicateKeyError(depth6)).toBe(false)
  })

  it('cause が自分自身を指していても止まる', () => {
    const loop: { cause?: unknown, code?: string } = {}
    loop.cause = loop
    expect(isDuplicateKeyError(loop)).toBe(false)
  })

  it('重複キー以外のエラーは false を返す', () => {
    expect(isDuplicateKeyError(new Error('boom'))).toBe(false)
    expect(isDuplicateKeyError({ code: 'ER_NO_SUCH_TABLE', errno: 1146 })).toBe(false)
    expect(isDuplicateKeyError(null)).toBe(false)
    expect(isDuplicateKeyError(undefined)).toBe(false)
    expect(isDuplicateKeyError('ER_DUP_ENTRY')).toBe(false)
  })
})
