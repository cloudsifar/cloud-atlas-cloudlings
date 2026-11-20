# 0010 — Moving between levels: dissolve, title, reveal

**Context.** Simon asked (20 November 2026) for a transition when "Next level" is
pressed: the screen becomes heavily pixelated and blurry for about two seconds, then the
new level's number and name appear in large letters in the middle of the screen, then
they disappear and the new sky is seen with whatever is already in place.

**Decision.**

- **"Next level"**: the old level dissolves into blurred pixel blocks over 2 s (blocks
  grow from 1 to 32 px, blur from 0 to 6 px, easing in). At the peak, out of sight, the
  new level is mounted. Its number and name appear in Press Start 2P at 48 px, on two
  lines ("Level 3" / "The Rain Store"), for 1.4 s. Then the title fades while the new
  sky sharpens over 0.8 s, and the filter is removed entirely.
- **A level chosen from the menu** (or Guided Run) starts at the title: no dissolve,
  because there is no old sky to leave. Resume shows no title at all.
- **How:** an SVG filter samples one dot per block and spreads it across the block,
  chained with a CSS blur, applied to the game layer only; the title sits on its own
  layer above it, so it stays crisp. The title layer takes clicks while it is up, so
  nothing in either level can be changed mid-transition. `src/ui/transition.ts`.
- **Reduced motion:** no pixels or blur; the title appears, holds and fades.

**Consequences.** A level takes about 4.2 s to arrive from "Next level" and 2.2 s from
the menu. The timings are constants at the top of `transition.ts`.
