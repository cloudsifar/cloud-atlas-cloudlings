# Final sound recordings

Put a recording here and name it in `assets/sounds.json` (`"file": "level-dissolve.mp3"`).
MP3 and WAV decode in every current browser.
Vite copies this folder to the top of `dist/` unchanged, and the game fetches
`sounds/<file>` relative to the page. Until an effect names a file, or if its file fails
to load, the game plays the synthesised placeholder from `assets/sounds.json`.

`level-dissolve` plays while the screen dissolves between levels and should last 2.0
seconds, the length of the dissolve (ADRs 0010 and 0011).
