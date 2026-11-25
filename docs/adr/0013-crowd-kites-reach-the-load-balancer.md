# 0013 — Crowd kites fly all the way to the load balancer

**Context.** After the Level 5 rebuild (ADR 0012), Simon asked (25 November 2026) for
every Cloudling's kite to float up to the load balancer, even though the furthest
Cloudlings then need long strings and the kites overlap. In the other levels a kite
reaches into its cloud: attached means a connection was made, and a kite that is turned
away falls to the ground. A kite held a little above its Cloudling's head, as ADR 0012
drew it, says neither, so it is ambiguous.

**Decision.** This replaces ADR 0012's "a kite with room flies steadily" and "sags to the
ground" (`src/game/crowdPlayback.ts`, `memberViewAt`; `src/game/render.ts`, `drawCrowd`).

- Every kite in the crowd goes up on a string from its Cloudling's hand to its own place
  in the underside of the load balancer. Kites are spread in two staggered rows across
  the cloud's width, tucked in clear of its name.
  - The regulars send theirs up during the first minute.
  - A newcomer walks on, then sends its kite up over `RISE_TICKS` (0.6 minute), so it
    reaches the load balancer just as the minute it counts begins.
- With room, the kite stays attached and its string stays taut. Now and then data rains
  back on its Cloudling.
- With no room, the kite is knocked loose and falls to the ground beside its Cloudling
  over `FALL` (half a minute). Its string goes slack and its Cloudling droops. It lies
  there while there is no room, then rises and attaches again once new instances are
  serving.
  - Which kites have no room is unchanged: the shortfall is spread evenly through the
    crowd (`fateOf`), because when targets are overloaded any request can time out,
    not only the newest.
- A leaver reels its kite in from wherever it is, then walks off.
- If the crowd is stopped before the load balancer (a misconfiguration), the kites go
  up to the place where they are stopped, and fall.
- The dots that climbed from the crowd to the load balancer are gone: the strings show
  that way now. The dots from the load balancer on to each cloud serving kites stay, so
  a group nobody sends kites to still visibly gets none.

**Consequences.**

- With 40 Cloudlings there are 40 strings converging on the load balancer, crossing the
  Internet Gateway's label. That is the trade Simon chose, and the labels stay readable.
- Tests: the regulars' kites rise during the first minute; a newcomer's kite is on its
  way up before it counts, then attached; a leaver reels in before walking off. A kite
  knocked loose falls, lies on the ground while there is no room, and rises when there
  is (checked with a 60% target, where there is no room at minutes 6–7 and room again
  from minute 8).
- The old test "a regular is there from the start, already flying" became "its kite
  floats up during the first minute". That is the behaviour Simon asked for, so the old
  test could not stay.
