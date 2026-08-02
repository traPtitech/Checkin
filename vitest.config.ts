import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Not every workspace uses src/ (Nuxt 4 apps use app/ and server/
    // instead), so match test files anywhere under a workspace, excluding
    // build output.
    include: ['{apps,packages}/*/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.nuxt/**', '**/.output/**', '**/dist/**'],
  },
})
