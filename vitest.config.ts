import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests for pure domain logic. DB-backed behavior is covered by manual
    // E2E against a running MariaDB (see the change's tasks).
    include: ['packages/**/*.test.ts'],
  },
})
