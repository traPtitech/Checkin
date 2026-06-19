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
  // Nuxt pages map to routes, so single-word filenames (index, login, ...) are fine.
  files: ['apps/web/app/pages/**/*.vue'],
  rules: {
    'vue/multi-word-component-names': 'off',
  },
})
