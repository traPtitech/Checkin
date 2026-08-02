// @ts-check
// Root flat config. `@nuxt/eslint` generates a project-aware config (Vue + TS +
// stylistic formatting) during `nuxt prepare`; we extend it across the monorepo.
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
    // Dotfolders are tool-generated (.claude, .understand-anything, .remember, ...)
    // and self-manage their own gitignore; exclude the whole class so a new tool
    // never requires touching this config again.
    '**/.*/**',
  ],
}, {
  // Nuxt pages map to routes, so single-word filenames (index, login, ...) are fine.
  files: ['apps/web/app/pages/**/*.vue'],
  rules: {
    'vue/multi-word-component-names': 'off',
  },
}, {
  rules: {
    // Allow warn/error for real diagnostics; log/debug/info shouldn't reach a commit.
    'no-console': ['error', { allow: ['warn', 'error'] }],
  },
},
// flat/recommended[0] is global setup (plugin registration + languageOptions,
// no rules) and should stay unscoped; only [1] carries the a11y rules and
// needs scoping to apps/web so it doesn't apply outside the Nuxt app.
pluginVueA11y.configs['flat/recommended'][0], {
  ...pluginVueA11y.configs['flat/recommended'][1],
  files: ['apps/web/**/*.vue'],
})
