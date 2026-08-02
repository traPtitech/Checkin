// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint'],
  devtools: { enabled: true },
  runtimeConfig: {
    // Override at runtime via NUXT_DATABASE_URL.
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
    // Nuxt generates separate tsconfigs per context (app/shared/node/server)
    // under apps/web/.nuxt/; extend the monorepo's strict base into all of
    // them, not just the app one. Path is relative to that generated file.
    tsConfig: { extends: '../../../tsconfig.base.json' },
    sharedTsConfig: { extends: '../../../tsconfig.base.json' },
    nodeTsConfig: { extends: '../../../tsconfig.base.json' },
  },
  eslint: {
    config: {
      stylistic: true,
      typescript: {
        // Resolved relative to the monorepo root (eslint's tsconfigRootDir),
        // not this file's directory.
        tsconfigPath: './apps/web/tsconfig.json',
      },
    },
  },
})
