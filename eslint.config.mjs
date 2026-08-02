// @ts-check
// ルートのフラット設定。`@nuxt/eslint` は `nuxt prepare` 時にプロジェクトを
// 考慮した設定(Vue + TS + stylistic フォーマット)を生成する。それをモノレポ
// 全体に拡張している。
import pluginVueA11y from 'eslint-plugin-vuejs-accessibility'
import withNuxt from './apps/web/.nuxt/eslint.config.mjs'

export default withNuxt({
  ignores: [
    '**/.nuxt/**',
    '**/.output/**',
    '**/dist/**',
    '**/node_modules/**',
    'packages/db/drizzle/**',
    'openspec/**',
    // ドットフォルダはツールが生成するもの(.claude, .understand-anything,
    // .remember, ...)で、それぞれ独自に gitignore を管理している。この
    // クラス全体を除外しておけば、新しいツールが増えてもこの設定を
    // 触る必要がなくなる。
    '**/.*/**',
  ],
}, {
  // Nuxt のページはルートに対応するため、単語1つのファイル名(index, login, ...)でも問題ない。
  files: ['apps/web/app/pages/**/*.vue'],
  rules: {
    'vue/multi-word-component-names': 'off',
  },
}, {
  rules: {
    // 本物の診断用途である warn/error は許可する。log/debug/info はコミットに残すべきではない。
    'no-console': ['error', { allow: ['warn', 'error'] }],
    // `==`/`!=` は比較前にオペランドの型を強制変換してしまい、本物のバグ
    // (`0 == ''`, `null == undefined`, ...)を覆い隠す。
    'eqeqeq': 'error',
  },
}, {
  // 型を考慮したルールは、Nuxt が生成する設定のうち TS パーサーがアタッチ
  // されている箇所(これらと同じ拡張子にスコープされる)でのみ解決される
  // -- eslint.config.mjs のような設定ファイルはプレーンな espree のままで、
  // チェック対象となる型情報を持たない。
  files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.vue'],
  rules: {
    // `!` は実行時のチェックを伴わずに型チェッカーを回避する。使用箇所で
    // 実行時にクラッシュさせるのではなく、実際のエラーメッセージも得られる
    // 明示的な null/undefined チェックを優先する。
    '@typescript-eslint/no-non-null-assertion': 'error',
    // union に対する switch で全メンバーを処理しなくてもコンパイルは通り、
    // 未対応のケースでは実行時に黙ってフォールスルーしてしまう。
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
    // 代わりに型を考慮したバージョンを使う。こちらは型のみのシャドーイング
    // (例: ローカルの `type Foo` がインポートしたものをシャドーイングする)も検出する。
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    // `||` は null/undefined だけでなく、あらゆる falsy な値(0, '', false)で
    // フォールスルーしてしまい、falsy だが有効な値を黙って上書きしてしまう。
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',
    // `as` 型アサーションは型チェッカーを迂回し、実際とズレた型を黙って通すため
    // 原則禁止する(const アサーション `as const` は本ルールが常に許可)。テストの
    // スタブなど安全が確認できる箇所のみ、理由を添えて eslint-disable で個別に許可する。
    '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
  },
},
// flat/recommended には、ルールだけでなく languageOptions.globals に
// ブラウザのグローバル一式(window, document, ...)も設定するエントリと、
// 実際の a11y ルールと vue-eslint-parser を担うエントリが含まれる。
// 両方とも apps/web にスコープしないと、ブラウザグローバルが Vue でない
// 全パッケージ(packages/api, packages/db, ...)に漏れ出してしまう。
// (eslint-plugin-vuejs-accessibility のバージョンアップ時は配列構成を再確認すること)
...pluginVueA11y.configs['flat/recommended'].map(config => ({
  ...config,
  files: ['apps/web/**/*.vue'],
})))
