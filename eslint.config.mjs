// @ts-check
// Root flat config. `@nuxt/eslint` generates a project-aware config (Vue + TS +
// stylistic formatting) during `nuxt prepare`; we extend it across the monorepo.
import withNuxt from './apps/web/.nuxt/eslint.config.mjs'

export default withNuxt({
  ignores: [
    '**/.nuxt/**',
    '**/.output/**',
    '**/dist/**',
    '**/node_modules/**',
    'packages/db/drizzle/**',
    'openspec/**',
    '.claude/**',
  ],
}, {
  // Nuxt pages/layouts map to routes/named layouts, so single-word filenames
  // (index, login, default, ...) are fine.
  files: ['apps/web/app/pages/**/*.vue', 'apps/web/app/layouts/**/*.vue'],
  rules: {
    'vue/multi-word-component-names': 'off',
  },
})
