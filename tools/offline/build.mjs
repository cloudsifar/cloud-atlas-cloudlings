// Bundles the game into dist/ with esbuild, for machines without Vite.
// Needs esbuild: either installed in the project or pointed at by ESBUILD_PATH.
// The normal build is `npm run build` (Vite). See docs/adr/0002.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const esbuild = require(process.env.ESBUILD_PATH ?? 'esbuild')

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist/assets', { recursive: true })

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/assets/main.js',
  // The title font is copied beside the bundle, as Vite does.
  loader: { '.ttf': 'file' },
  logLevel: 'info',
})

// Same page as Vite serves, with the entry point swapped for the bundle. Paths stay relative.
const html = readFileSync('index.html', 'utf8').replace(
  '<script type="module" src="/src/main.ts"></script>',
  '<link rel="stylesheet" href="assets/main.css" />\n    <script type="module" src="assets/main.js"></script>',
)
writeFileSync('dist/index.html', html)
