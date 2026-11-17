import { defineConfig } from 'vitest/config'

// `base: './'` makes every asset path relative, so `dist/` can be dropped into
// any S3 prefix behind CloudFront without server-side routing (brief, Section 3).
export default defineConfig({
  base: './',
  build: { outDir: 'dist', assetsInlineLimit: 0 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
})
