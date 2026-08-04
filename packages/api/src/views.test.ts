import { describe, expect, it } from 'vitest'
import { idOf, toListResponse } from './views'

describe('idOf', () => {
  it('文字列参照はそのまま返す', () => {
    expect(idOf('cus_1')).toBe('cus_1')
  })

  it('展開オブジェクトは id だけを取り出す(PII を出さない)', () => {
    expect(idOf({ id: 'cus_1' })).toBe('cus_1')
  })

  it('null はそのまま null', () => {
    expect(idOf(null)).toBeNull()
  })
})

describe('toListResponse', () => {
  const id = (x: { id: string }) => x.id

  it('has_more が true なら nextCursor は data の末尾要素の id', () => {
    const page = { has_more: true, data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    // 末尾(c)を選ぶ。先頭(a)を返す実装への退行を捕まえる。
    expect(toListResponse(page, id).nextCursor).toBe('c')
  })

  it('has_more が false なら nextCursor は null', () => {
    const page = { has_more: false, data: [{ id: 'a' }, { id: 'b' }] }
    expect(toListResponse(page, id).nextCursor).toBeNull()
  })

  it('has_more が true でも data が空なら nextCursor は null', () => {
    // Stripe は has_more:true で空 data を返さないが、undefined を漏らさず null に倒す。
    const data: { id: string }[] = []
    expect(toListResponse({ has_more: true, data }, id).nextCursor).toBeNull()
  })

  it('data は toView で射影し、カーソルは Stripe ソースの id から導出する', () => {
    // toView が id を落としても、カーソルはソース(page.data)の id を使う。
    const page = { has_more: true, data: [{ id: 'src_1' }, { id: 'src_2' }] }
    const result = toListResponse(page, item => ({ id: item.id, label: `v:${item.id}` }))
    expect(result.data).toStrictEqual([
      { id: 'src_1', label: 'v:src_1' },
      { id: 'src_2', label: 'v:src_2' },
    ])
    expect(result.nextCursor).toBe('src_2')
  })
})
