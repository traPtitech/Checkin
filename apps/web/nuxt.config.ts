// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint'],
  devtools: { enabled: true },
  runtimeConfig: {
    // 実行時に NUXT_DATABASE_URL で上書き可能。
    databaseUrl: process.env['DATABASE_URL'] ?? '',
  },
  compatibilityDate: '2025-01-01',
  nitro: {
    typescript: {
      tsConfig: { extends: '../../../tsconfig.base.json' },
    },
  },
  typescript: {
    typeCheck: false,
    // Nuxt は apps/web/.nuxt/ 配下にコンテキストごと(app/shared/node/server)に
    // 別々の tsconfig を生成する。app 用だけでなく、その全てにモノレポの
    // 厳格な base 設定を継承させる。パスは生成後のファイルからの相対パス。
    tsConfig: {
      extends: '../../../tsconfig.base.json',
      vueCompilerOptions: {
        // このリポジトリとは無関係な後方互換の理由からデフォルトは無効。
        // テンプレート内の式・バインディング(props, v-model, イベント
        // ハンドラ)を緩めずに script コードと同じ厳格さで型チェックする。
        strictTemplates: true,
        // コンポーネントのルート要素へフォールスルーする属性(例:
        // ルートが <a> のコンポーネントに `href` を渡す場合)を、
        // defineProps 未宣言の属性として unknown-prop エラーにするのではなく、
        // そのルート要素本来の型に対して型チェックする。
        fallthroughAttributes: true,
      },
    },
    sharedTsConfig: { extends: '../../../tsconfig.base.json' },
    nodeTsConfig: { extends: '../../../tsconfig.base.json' },
  },
  eslint: {
    config: {
      stylistic: true,
      typescript: {
        // このファイルのディレクトリではなく、モノレポルート
        // (eslint の tsconfigRootDir)からの相対パスで解決される。
        tsconfigPath: './apps/web/tsconfig.json',
      },
    },
  },
})
