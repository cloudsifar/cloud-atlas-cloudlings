# 0001 — Render the sky with Canvas 2D and no library

**Context.** The brief allows Canvas 2D or one small rendering library. The sky needs
clouds, kites, strings, rain particles and crowds of 40+ Cloudlings; menus and cards
are DOM.

**Options.** (a) Canvas 2D. (b) PixiJS. (c) SVG in the DOM.

**Decision.** Canvas 2D. It adds no runtime dependency and no bundle weight, it draws a
few hundred sprites per frame comfortably, and the drawing code is plain function calls
that an intermediate TypeScript reader can follow. Placeholder sprites are drawn
procedurally; final art is drawn with `drawImage` from the asset manifest.

**Consequences.** Hit-testing is our own code (`src/game/layout.ts` returns rectangles;
the pointer handler asks which one contains the pointer). Per-sprite tinting is done by
compositing rather than shaders. If crowds ever outgrow Canvas 2D, only
`src/game/render*.ts` would change: the engine and game state do not know how they are drawn.
