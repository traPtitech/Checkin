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
    // `==`/`!=` coerce operand types before comparing, which papers over
    // real bugs (`0 == ''`, `null == undefined`, ...).
    'eqeqeq': 'error',
  },
}, {
  // Type-aware rules only resolve where Nuxt's typescript config attaches the
  // TS parser (nuxt/typescript/rules, scoped to these same extensions) --
  // config files like eslint.config.mjs stay on plain espree and have no type
  // information to check against.
  files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.vue'],
  rules: {
    // `!` bypasses the type checker with no runtime check behind it. Prefer
    // an explicit null/undefined check (which also gives a real error
    // message instead of a runtime crash at the point of use).
    '@typescript-eslint/no-non-null-assertion': 'error',
    // A switch over a union that doesn't handle every member compiles fine
    // and silently falls through at runtime for the missing case.
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
    // Use the type-aware version instead, which also catches type-only
    // shadowing (e.g. a local `type Foo` shadowing an imported one).
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    // `||` falls through on any falsy value (0, '', false), not just
    // null/undefined, and silently overwrites values that are falsy but
    // valid.
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',
  },
},
// Both flat/recommended entries need scoping to apps/web: [0] isn't rule-free
// setup, it also sets languageOptions.globals to the full browser global set
// (window, document, ...), which would otherwise leak into every non-Vue
// package (packages/api, packages/db, ...) if left unscoped. [1] carries the
// actual a11y rules plus the vue-eslint-parser.
...pluginVueA11y.configs['flat/recommended'].map(config => ({
  ...config,
  files: ['apps/web/**/*.vue'],
})))
