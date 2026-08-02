import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 全ワークスペースが src/ を使うわけではない(Nuxt 4 アプリは代わりに
    // app/ と server/ を使う)ため、ビルド成果物を除きワークスペース配下の
    // どこにあるテストファイルにもマッチさせる。
    include: ['{apps,packages}/*/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.nuxt/**', '**/.output/**', '**/dist/**'],
  },
})
