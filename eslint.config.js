import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Layering rule (docs/ARCHITECTURE.md): UI -> game -> levels -> engine, one way only.
// tests/architecture.test.ts enforces the same rule without needing ESLint.
const forbid = (patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
})

export default tseslint.config(
  { ignores: ['dist', '.offline-build', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  // The offline tools are plain Node scripts that use one Node global. It is declared here
  // rather than adding the `globals` package for a single name.
  { files: ['tools/**/*.mjs'], languageOptions: { globals: { process: 'readonly' } } },
  { files: ['src/engine/**'], rules: forbid(['**/levels/**', '**/game/**', '**/ui/**']) },
  { files: ['src/levels/**'], rules: forbid(['**/game/**', '**/ui/**']) },
  { files: ['src/game/**'], rules: forbid(['**/ui/**']) },
)
