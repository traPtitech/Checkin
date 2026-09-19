import { describe, expect, it } from 'vitest'
import { positiveNumberOr } from './config-value'

/**
 * `resolveAuthConfig` と `resolveBillingConfig` が同じ本体をそれぞれ持っていた
 * 関数を1つにまとめたもの。runtimeConfig の値は文字列で届くので、数として読め
 * ない値と 0 以下の値を既定値へ落とす境界を固定する。
 */
describe('positiveNumberOr', () => {
  it('正の数として読める文字列はその数にする', () => {
    expect(positiveNumberOr('465', 587)).toBe(465)
  })

  it('小数も丸めずにそのまま通す', () => {
    expect(positiveNumberOr('7.5', 7)).toBe(7.5)
  })

  it('前後の空白は数の一部として扱わない', () => {
    expect(positiveNumberOr(' 12 ', 7)).toBe(12)
  })

  it('0 と負の数は既定値にする', () => {
    expect(positiveNumberOr('0', 7)).toBe(7)
    expect(positiveNumberOr('-1', 7)).toBe(7)
  })

  it('数として読めない文字列は既定値にする', () => {
    expect(positiveNumberOr('', 7)).toBe(7)
    expect(positiveNumberOr('abc', 7)).toBe(7)
  })

  it('無限大は既定値にする', () => {
    expect(positiveNumberOr('Infinity', 7)).toBe(7)
  })
})
