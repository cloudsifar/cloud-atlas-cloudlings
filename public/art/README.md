# Final art

Put a picture here and name it in `assets/manifest.json` (`"file": "cumulus-load-balancer.webp"`).
Vite copies this folder to the top of `dist/` unchanged, and the game loads
`art/<file>` relative to the page. Until an entry names a file, or if its file fails to
load, the game draws its placeholder in code.

What to make, at what size, with which anchor, frames and layers, is listed in
`docs/ASSET_LIST.md`, generated from the manifest (`npm run assets:list`).
