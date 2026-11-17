# 0005 — Crowds run on a timeline of moments; a surge is an event on it

**Context.** Level 5 needs a crowd that grows from 4 to about 40 Cloudlings and back
(brief, Section 11), and Levels 6 and 12 need events on the same clock: an Availability
Zone failing, the application failing. The brief lists `applyEvent(scene, event) → scene`
among the engine's entry points, and says level files hold events "on a timeline".
The first version of Level 5 described the crowd as a list of phases inside the level's
`crowd` field, so the surge was not an event at all and `LevelEvent` stayed `never`.

**Options.**

1. Keep phases in the crowd field.
2. Make every event, a crowd surge included, a pure `applyEvent(scene, event)`.
3. Split the timeline from the simulation. A level states its usual crowd (`crowd`:
   kites per tick and how many ticks the run lasts) and its scripted events
   (`events`). `crowdTimeline(crowd, events)` turns those into one _moment_ per tick.
   `simulateCrowd(scene, crowd, moments)` steps through any list of moments.

**Decision.** Option 3, in `src/engine/timeline.ts` and `src/engine/crowd.ts`.

- A crowd surge changes who is flying, not the architecture. Folding it into the scene
  (option 2) would put people on the ground into a model of AWS resources. So a surge
  changes the moments: how many kites fly, and whether a surge is under way.
- `applyEvent(scene, event) → scene` is still the plan for events that _do_ change the
  scene. It arrives with the first one, the Availability Zone failure in Level 6. A
  moment will then also carry the scene events that happen on that tick, and the
  simulation will apply them before evaluating the tick.
- The simulation can be tested with any pattern of demand, written by hand, and the
  timeline can be tested without simulating anything. Both test files stay small.

**Related choices made at the same time.**

- _Timed-out kites have a journey._ Each tick records the engine's journey for a served
  kite and, when capacity ran out, for a timed-out kite: the same checks up to the load
  balancer, then a failing `capacity` check (HTTP 504). Playback and the trace inspector
  read these, so neither re-derives anything. Every kite in a crowd is alike, so one
  journey per fate speaks for all of them.
- _Each tick records each Auto Scaling group's own instances_ (serving and launching),
  so the fleet's cloud can grow and shrink. The load balancer's target count is not
  enough, because a player may keep fixed instances alongside a group.
- _The objective counts the surge._ `crowd-delivered-at-least` takes `during: 'surge'`,
  matching the brief's "at least 95% of green kites delivered during the surge".

**Consequences.** Level files gain a real `events` list, validated (event inside the
run, peak above the usual crowd, a surge needs a crowd). `LevelEvent` is now
`ScenarioEvent`; new kinds are added there and in the validator. The surge's shape is a
straight climb, a hold and a straight fall; that is a game convention, not AWS
behaviour, so it is not listed in `docs/SIMPLIFICATIONS.md`.
