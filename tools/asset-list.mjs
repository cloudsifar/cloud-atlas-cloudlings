// Writes docs/ASSET_LIST.md, the list of art to make, from assets/manifest.json, so the
// two never disagree. Run with `npm run assets:list` after changing the manifest;
// tests/game/art.test.ts fails if the committed list is out of date.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PRIORITY_TITLES = {
  1: 'Priority 1: the essentials (ship with these)',
  2: 'Priority 2: the full scene',
  3: 'Priority 3: finishing touches',
}

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ')

/** The list as Markdown, from the parsed manifest. */
export function renderAssetList(manifest) {
  const entries = Object.entries(manifest.sprites)
  const drawn = entries.filter(([, entry]) => entry.status !== 'planned')
  const planned = entries.filter(([, entry]) => entry.status === 'planned')
  const lines = [
    '# Asset list',
    '',
    '<!-- Generated from assets/manifest.json by `npm run assets:list`. Do not edit by hand. -->',
    '',
    'Every picture the game draws, with the size, anchor and frames the code expects. Each',
    'one is drawn as a placeholder in code until its picture exists. To add one:',
    '',
    '1. Draw it as a transparent PNG at the size given (or a multiple of it, same proportions),',
    '   and export it to WebP.',
    '2. Put the WebP in `public/art/`.',
    '3. In `assets/manifest.json`, set the entry\'s `file` to the file name.',
    '',
    'No code changes. If a picture fails to load, its placeholder is drawn instead.',
    '',
    '- **Anchor**: the point of the picture placed on its position, as fractions of its width',
    '  and height (`0.5, 1` is the middle of the bottom edge: a Cloudling\'s feet).',
    '- **Frames**: frames side by side in one strip, left to right, each the size given,',
    '  played at the rate shown.',
    '- **Points**: named places on the picture, as fractions (a Cloudling\'s hand holds the string).',
    '- **Between two points**: stretched from one to the other, or repeated (tiled) along the way.',
    '- **Clouds come in two layers.** The base layer is light and near-neutral, so code can tint',
    '  it blue by band, grey when unhealthy and red when compromised; the pencil texture must',
    '  survive the tint. An optional highlight layer (`highlight` in the manifest) carries the',
    '  golden sunlight and the white burst; without one, a soft glow cut to the base\'s shape is',
    '  used. Both layers are the same size.',
    '- **The sky itself** is a gradient drawn in code in every region, so it costs no file.',
    '',
  ]
  for (const priority of [1, 2, 3]) {
    const inPriority = drawn.filter(([, entry]) => entry.priority === priority)
    if (inPriority.length === 0) continue
    lines.push(`## ${PRIORITY_TITLES[priority]}`, '')
    const groups = [...new Set(inPriority.map(([, entry]) => entry.group))]
    for (const group of groups) {
      lines.push(`### ${group}`, '')
      lines.push('| Id | Size (px) | Anchor | Frames | Notes | Description | File |')
      lines.push('| --- | --- | --- | --- | --- | --- | --- |')
      for (const [id, entry] of inPriority.filter(([, candidate]) => candidate.group === group)) {
        const notes = [
          entry.repeat ? `between two points, ${entry.repeat === 'tile' ? 'tiled' : 'stretched'}` : '',
          entry.points
            ? Object.entries(entry.points)
                .map(([name, [x, y]]) => `${name} at ${x}, ${y}`)
                .join('; ')
            : '',
          entry.highlight !== undefined ? 'base + highlight layers' : '',
          entry.states ?? '',
        ].filter(Boolean)
        lines.push(
          `| \`${id}\` | ${entry.width} × ${entry.height} | ${entry.anchor.join(', ')} | ${
            (entry.frames ?? 1) > 1 ? `${entry.frames} at ${entry.fps ?? 8} fps` : '1'
          } | ${cell(notes.join('. '))} | ${cell(entry.description)} | ${entry.file ? `\`${entry.file}\`` : 'placeholder'} |`,
        )
      }
      lines.push('')
    }
  }
  if (planned.length > 0) {
    lines.push('## Planned: not drawn yet', '')
    lines.push(
      'These are on the list so they can be made, but the game does not draw them yet. Each one is',
      'hooked up, with its entry checked by the tests, when the feature that shows it is built.',
      '',
    )
    lines.push('| Id | Size (px) | Description |')
    lines.push('| --- | --- | --- |')
    for (const [id, entry] of planned)
      lines.push(`| \`${id}\` | ${entry.width} × ${entry.height} | ${cell(entry.description)} |`)
    lines.push('')
  }
  return lines.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync('assets/manifest.json', 'utf8'))
  writeFileSync('docs/ASSET_LIST.md', renderAssetList(manifest))
  console.log('Wrote docs/ASSET_LIST.md')
}
