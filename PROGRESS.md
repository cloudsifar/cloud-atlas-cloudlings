# Progress

Running log. Newest state first; updated at the end of every milestone.

## Status

- [x] **Milestone 0** — plan, core types, ADRs
- [x] **Milestone 1** — engine core (routing, security groups, network ACLs, IAM, S3, load
      balancer target selection) with tests citing AWS docs; `docs/ENGINE.md`,
      `docs/SIMPLIFICATIONS.md`
- [x] **Milestone 2** — Levels 1–3 playable with placeholder art
- [ ] **Milestone 3** — in progress: Levels 4 (Skyway) and 5 (Crowd Day) finished; Levels 6–12
      and the rest of the engine to do. See "Handover: what to build next" below
- [ ] Milestone 4 — shell (partly started: start screen, level select with ticks and stars,
      Guided Run from Level 1 with "Next level", settings)
- [ ] Milestone 5 — finish

## What was verified, and how

- **The first playtest changes** (ADR 0007, 19 November 2026), in the cloud sandbox:
  202 tests pass with `npm run offline:test` (15 new: drop zones, narration rewind,
  `says` and `removalWarnings` validation), and the type-check is clean. ESLint,
  Prettier and the project `tsc` were run against the installed packages (see below).
  In headless Chromium on the esbuild bundle: Level 1 played with every new behaviour
  (speech bubbles; a mouse click on a tray card does not place it; a drop over the mid
  band sends the gateway back to the tray with its explanation; the low band lights up
  and takes it; subnet tint and card header turn public when the route is added; the
  removal warning appears, "Keep it" keeps the load balancer, "Remove anyway" removes it
  and the narrator returns to "place the load balancer"; the CIDR card; Menu then Resume
  keeps the scene and the narrator step). Levels 2–5 replayed to three stars. A flight
  paused for five seconds in the menu carried on from where it was. Enter on a tray card
  still places the cloud. No console errors. **Not yet run on these changes:** Vitest
  and the Vite build on Windows (`npm test`, `npm run build`).
- **The real toolchain** (Windows, Node 26.13.1, npm 11.20.0, from the committed
  lockfile, 18 November 2026). Each step's output was read, not just its exit code, and
  a deliberately failing command confirmed that failures are reported:
  - `npm ci --ignore-scripts` installs cleanly, and `npx esbuild --version` then
    answers `0.28.2`: esbuild works without its install script (ADR 0006).
  - `npm test`: Vitest 4.1.12, **14 test files, 187 tests passed**.
  - `npm run build`: `tsc --noEmit` is clean, then Vite 7.3.8 writes `dist/`
    (`index.html`, one CSS file, one 169 kB JS bundle).
  - `npm run lint`: ESLint reports nothing; Prettier reports every file formatted.
  - `npm audit`: 0 vulnerabilities. `npm ls` shows vitest and `@vitest/mocker` at
    4.1.12 and no tinypool.
- **Offline runner** (the cloud build sandbox, which has no npm registry): the same 187
  tests pass with `npm run offline:test`, and the type-check with
  `tools/offline/tsconfig.json` is clean. See ADR 0002 for why it is kept.
- **In a browser (headless Chromium, 1280×720):** the Vite build above was played
  through Levels 1–5 to their objectives, three stars on each, no console errors. The
  detailed runs below were on the earlier esbuild bundle:
  - Levels 1 to 4 played from start to their objectives through the real interface
    (dragging clouds from the tray, routes and rules on config cards, targets, roles,
    flying the kites, the trace inspector), and replayed after the Level 5 changes.
    Three stars were read off the side panel for Levels 1–3.
  - Level 5: the unsolved run (crowd visibly timing out, 35% during the surge) and the
    solved run (Auto Scaling group placed, maximum 8, 50% CPU target, load balancer
    pointed at it, fixed instances removed) were played through the interface. The
    solved run met its objective (98% during the surge) and the side panel and the
    results card both showed three stars. "Follow a kite that timed out" opened the
    inspector on a capacity failure. With `prefers-reduced-motion` the run jumps to
    its final frame.
  - No console errors in any of these runs.

## Not verified — do these first

1. **A person playing it again.** Simon played Levels 1–5 in a real browser on
   18–19 November; his changes are in ADR 0007. They need his eye: how dragging feels
   now, the sound levels, the subnet tints, the speech bubbles, Resume.
2. Firefox, Safari and Edge. Only Chromium was tried.
3. Window sizes other than 1280×720, tablets, and the phone path.
4. Sound. The synthesised placeholders exist but headless testing cannot hear them.
   Simon heard them in the first playtest: the click and card sounds were too quiet and
   the level-complete jingle too loud, now adjusted (ADR 0007). Level 5's four crowd
   cues and their blending have only been checked in code.
5. Frame rate with a crowd of 40 on a modest laptop or tablet. Chromium on the build
   machine was smooth; nothing was measured.
6. The AWS documentation links cited in the test files. Five behaviours were re-checked
   against the current AWS docs during the build (ALB health checks and fail-open, S3
   Block Public Access, network ACLs and ephemeral ports, IAM policy evaluation, route
   priority and gateway endpoints), and for Level 5: target tracking scaling, Auto
   Scaling capacity limits (desired between minimum and maximum), and ALB HTTP 504
   when a busy target does not answer in time. The other links were not each opened:
   click through them once.

## Known issues

- **ESLint 9 is past end of life** (6 August 2026). Upgrading to ESLint 10 and
  `@eslint/js` 10 is a separate major change; not needed for any advisory.
- **Asset swapping is half built.** `assets/manifest.json` sets each sprite's size and
  anchor, but the renderer does not yet load image files: setting `file` has no effect.
  Placeholders are always drawn in code.
- **Label overlaps** in the low band: the load balancer's caption runs into the
  "public: routes to the Internet Gateway" notes and sits close to the gateway cloud.
- **The results card opens the moment the kites land**, covering the sky. "Keep
  building" closes it. A short delay would let the player watch the ending.
- New security group rules default to HTTPS 443 in the port dropdown; Level 2 needs
  HTTP 80, which is easy to miss. The narrator names the port, and the step does not
  advance until the right rule exists.
- Level 5: the fleet's caption ("2–8 instances · CPU target 50%") sits on the line
  between the mid and low bands; during a crowd run the kites cover the Internet
  Gateway's label. Both are readable, neither is tidy.
- Level 5: clicking one of the four named Cloudlings after a crowd run opens _its own_
  journey, flown at a quiet moment, so it is always delivered when the network is
  right. The crowd's journeys (timed out, or got through at the busiest tick) are
  opened from the weather station's "Follow a kite…" links.

## Not started (from the brief)

- Engine: WAF, scene events (`applyEvent`: AZ failure, instance failure), replacing
  unhealthy instances in a group, RDS, DynamoDB, SQS, SNS, Lambda, KMS, SSM, Route 53,
  CloudWatch alarms other than a scaling policy's (e.g. publishing to SNS), EBS, EFS,
  DynamoDB gateway endpoint flows, and the cost penalty for idle oversized instances.
- Levels 6–12.
- Demo Mode, Field Guide, About screen, phone path, link
  preview tags, regional scenes beyond N. Virginia, costumes.
- `docs/ASSET_LIST.md`, `CREDITS.md`, font choice ADR (the game currently uses system
  font stacks; no font files are bundled).
- A smoke test that the production build renders the start screen.
- Weight budget check (the esbuild bundle is 125 KB before gzip; there are no art files).

## Handover: what to build next

Work in this order. Each item is complete only when its tests pass under
`npm run offline:test` and the level has been played through in a browser.

**Rules that still apply (brief, Section 2).** AWS correctness first: check each rule
against the current AWS docs before coding it, and cite the page at the top of the
rule's test file. Never weaken or remove a test to get a pass. Every departure from
AWS goes in `docs/SIMPLIFICATIONS.md` and on a fact card. Levels are data; new logic
goes in the engine as a predicate with a test.

**How Level 4 was added (the pattern to repeat).**

1. Engine rule or model change in `src/engine/`, with a test file in `tests/engine/`.
2. Any new predicate in `src/engine/predicates.ts`, exported through `index.ts`.
3. Level JSON in `levels/`, registered in `src/levels/loader.ts`. The level tests then
   run automatically (validates; starts unsolved; reference solution earns three
   stars; narration completable).
4. UI for any new control in `src/ui/configCards.ts`; drawing in `src/game/render.ts`,
   driven by engine functions, never by re-deriving a rule.
5. Fact cards in `content/fact-cards.json`; docs: `ENGINE.md`, `SIMPLIFICATIONS.md`,
   `LEVEL_AUTHORING.md`, this file.

**Level 5, Crowd Day: finished.** What the level now does (brief, Sections 5–8, 11):

- The crowd surge is an event on the level's timeline (`events`), not level data in
  the crowd: 4 → 40 Cloudlings over 6 ticks, 6 at the peak, 6 back down, 9 quiet ticks.
  See ADR 0005 for why the timeline is separate from the simulation.
- The objective counts the surge only, as the brief says ("at least 95% … during the
  surge"). The third star is capacity scaling back in afterwards.
- The crowd is in the sky: up to 41 Cloudlings in two rows, each flying a kite every
  tick along the path the engine's journey took. Delivered kites vanish into the fleet,
  which flashes, and rain falls back; timed-out kites stall at the load balancer, go
  slack and drift down. Cloudlings cheer or droop.
- A timed-out kite has a full journey in the trace inspector, ending in a `capacity`
  check at the load balancer (HTTP 504), opened from the weather station panel.
- The fleet's cloud is a patch of cloudlets, one per instance; instances still
  launching are faint.
- CloudWatch is a weather station on the ground: CPU dial, anemometer spinning with the
  crowd, a bell that rings when an alarm goes into ALARM, and an "OK / ALARM" line in
  words (never colour alone). The side panel keeps the chart, a "during the surge"
  line, and a tick-by-tick table that now fits the panel.
- The fleet card sets instance size, minimum, desired and maximum (kept in order, as
  AWS requires) and the scaling policy.
- Sound: one pop and one blended crowd cheer per tick rather than forty; one "fwoop"
  and a crowd groan for timeouts; a shimmer when instances join; the alarm bell.
- Tuned by simulating builds (see `docs/LEVEL_AUTHORING.md`, "Crowds and events"): the
  start delivers 35% during the surge; maximum 8 small instances at 40–60% CPU target
  deliver 96–99%; a 70% or 80% target, or a maximum of 6, falls short; eight instances
  or two large ones all day pass the objective but not the third star.

Still not done for Level 5, and left for later milestones:

- The four regional costumes are still a tunic colour only (Milestone 5 art).
- The cost penalty for idle oversized instances (brief, Section 7) is not modelled; the
  player can now choose size, so it can be, when cost scoring matters (Level 12).
- The Field Guide entries for the new signs (bell, slack string, crowd) — Milestone 4.

**Level 6, Storm Front.** Add an `az-failure` kind to `ScenarioEvent`
(`src/engine/timeline.ts`) and a pure `applyEvent(scene, event) → scene`; let a moment
carry the scene events of its tick, applied by `simulateCrowd` before it evaluates the
tick (ADR 0005). Then: AZ failure as an event (everything in the AZ becomes
unhealthy, including a NAT Gateway; the ALB stops routing there; the ASG relaunches
elsewhere), RDS as a resource (private subnets, subnet group across two AZs, engine
port from the app tier's security group, Multi-AZ failover over a few ticks, standby
serves no reads), and an instance → database flow in `flow.ts`.

**Smaller jobs, any time.**

- Load sprite files named in `assets/manifest.json` (currently only sizes are used).
- Delay the results card until the kites' endings have played.
- Disclose simplifications 11b and 17 on fact cards.
- Fix the label overlaps in the low band.
- Write `docs/ASSET_LIST.md` and `CREDITS.md`; choose and bundle fonts, with an ADR.
- Regional costumes are a tunic colour only; the four regional skylines exist.

## Conflicts between the brief and AWS documentation

None found so far. Two places where the brief's wording was made more exact:

- A target the load balancer cannot reach (for example, shut out by its security group)
  fails its health check, so the load balancer routes around it; if no target is
  healthy the load balancer fails open and tries one anyway, as the ALB documentation
  describes. Described in `docs/ENGINE.md`, section 9.
- "Blocked by Block Public Access": with it on, the trace reports the anonymous request
  as stopped by Block Public Access even when the bucket policy grants nothing to the
  public (in AWS the request would also fail on the missing grant). Recorded in
  `docs/SIMPLIFICATIONS.md` (11b). **To do:** disclose it on the S3 fact card.

## Log

- **Session 1.** Milestones 0–2. One slip worth knowing about: part-way through, the
  session resumed without its earlier context and began rebuilding the engine on top of
  committed files. The overwritten files were restored from git before anything was
  committed, and the duplicate work was discarded; the history contains only the
  original line of work.
- **Session 1, continued.** Level 4 (Skyway): cost model, two predicates, gateway
  endpoint routes on route cards, `removableIds`, the skyway drawing, running-cost
  panel. Played to three stars in a browser; Levels 1 and 3 replayed as a regression
  check.
- **Session 1, continued.** Level 5 (Crowd Day): Auto Scaling groups, the crowd
  simulation with capacity and target tracking, weather-station panel. Played to a
  met objective in a browser; the reference solution earns three stars in the tests.
- **Session 2 (Claude Opus 5.5, picking up from Fable).** Finished Level 5. Engine: the
  timeline (`timeline.ts`) with crowd-surge events; timed-out kites with their own
  journey and a `capacity` check; per-group fleet sizes per tick; the surge-only
  objective; desired capacity validated. Sky: the crowd, timeouts, the growing fleet,
  the weather station and bell, blended crowd sound. Panels: fleet card (size,
  desired), weather station tidied, follow-a-kite links. Docs: ADR 0005, ENGINE 12–14,
  SIMPLIFICATIONS 24–26 (all crowd simplifications now on fact cards). Found and fixed
  on the way: `validateScene` had no case for Auto Scaling groups, the offline Vitest
  stand-in lacked `toBeNull`, and a doc comment in `flow.ts` sat on the wrong function.
- **Session 2, continued: the first real install.** `npm install` on Windows reported
  13 audit findings with three causes: `@vitest/mocker` and `tinypool` (both through
  Vitest 3) and `picomatch` (through Vite, Vitest and typescript-eslint, no fix
  published). Vitest moved to `^4.1.12`, the smallest change that clears the first two;
  Vite, typescript-eslint and ESLint stay on their majors. picomatch is accepted and
  tracked. Line endings normalised to LF with `.gitattributes`; esbuild's install
  script denied (its binary comes from an optional dependency). ESLint's first run
  found two undeclared `process` globals in the offline tools. ADR 0006.
- **Session 2, continued: the toolchain verified.** On Windows, from the committed
  lockfile: Vitest 4 ran the suite for the first time (187 passed), `npm run build` and
  `npm run lint` passed, esbuild worked with its install script denied. `npm audit`
  now reports nothing: GitHub withdrew the picomatch advisory on 18 November 2026, so
  nothing had to be accepted after all (ADR 0006). The Vite build was played through
  Levels 1–5 in headless Chromium.
- **Session 3: the first playtest.** Simon played Levels 1–5 and asked for changes,
  recorded in ADR 0007: a cloud is placed only if let go over the zone where it
  belongs, which lights up under the pointer (anywhere else it returns to the tray); the
  narrator goes back when a completed step is undone; Level 1 warns before the load
  balancer or gateway is removed; Cloudlings speak in bubbles instead of captions; the
  high band is "High – account"; public and private subnets are tinted; the VPC's range
  opens a CIDR card; the menu can be resumed; three sound levels changed. Level 3's
  narration now says where the bucket and role go.
