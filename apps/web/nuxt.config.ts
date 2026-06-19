// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint'],
  devtools: { enabled: true },
  runtimeConfig: {
    // Override at runtime via NUXT_DATABASE_URL.
    databaseUrl: process.env.DATABASE_URL ?? '',
  },
  compatibilityDate: '2025-01-01',
  typescript: {
    typeCheck: false,
  },
  eslint: {
    config: {
      stylistic: true,
    },
  },
})
