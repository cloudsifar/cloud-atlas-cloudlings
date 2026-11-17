# Progress

Running log. Newest state first; updated at the end of every milestone.

## Status

- [x] **Milestone 0** — plan, core types, ADRs
- [x] **Milestone 1** — engine core (routing, security groups, network ACLs, IAM, S3, load
      balancer target selection) with tests citing AWS docs; `docs/ENGINE.md`,
      `docs/SIMPLIFICATIONS.md`
- [x] **Milestone 2** — Levels 1–3 playable with placeholder art
- [ ] **Milestone 3** — in progress: Level 4 (Skyway) done; Levels 5–12 and the rest of
      the engine to do. See "Handover: what to build next" below
- [ ] Milestone 4 — shell (partly started: start screen, level select with ticks and stars,
      Guided Run from Level 1 with "Next level", settings)
- [ ] Milestone 5 — finish

## What was verified, and how

- **Tests:** 128 pass with `npm run offline:test` (the Vitest test files run on Node's
  test runner through a small stand-in for Vitest; see ADR 0002).
- **Type-check:** `tsc --noEmit` is clean apart from the two packages that could not be
  installed (`vitest`, `@types/node`).
- **In a browser (headless Chromium, 1280×720, esbuild bundle):** Levels 1, 2, 3 and 4 were
  each played from start to three stars through the real interface: dragging clouds from
  the tray, adding routes and rules on config cards, ticking targets, attaching the role,
  flying the kites, opening the trace inspector. No console errors.

## Not verified — do these first

1. `npm install`, then `npm test`, `npm run build`, `npm run lint`. **None of these has
   ever been run**: the build sandbox had no npm registry. Version ranges in
   `package.json` are guesses and there is no lockfile. ESLint has never seen this code.
2. Firefox, Safari and Edge. Only Chromium was tried.
3. Window sizes other than 1280×720, tablets, and the phone path.
4. Sound. The synthesised placeholders exist but headless testing cannot hear them.
5. The AWS documentation links cited in the test files. Five behaviours were re-checked
   against the current AWS docs during the build (ALB health checks and fail-open, S3
   Block Public Access, network ACLs and ephemeral ports, IAM policy evaluation, route
   priority and gateway endpoints). The other links were not each opened: click through
   them once.

## Known issues

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

## Not started (from the brief)

- Engine: WAF, Auto Scaling, capacity and timeouts, events (`applyEvent`), RDS, DynamoDB,
  SQS, SNS, Lambda, KMS, SSM, Route 53, CloudWatch, EBS, EFS, DynamoDB gateway endpoint
  flows, and the cost penalty for idle oversized instances.
- Levels 5–12.
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

**Level 5, Crowd Day (brief, Section 11).** Needs, in the engine:

- Time. Today every kite is evaluated once, independently. Level 5 needs ticks: a
  pure `simulate(scene, population, events) → per-tick results`, with a seeded or
  fixed schedule so the same scene gives the same verdict.
- Capacity: each instance size handles a fixed number of kites per tick; requests
  beyond total healthy capacity get outcome `dropped` (already in `FlowOutcome`'s
  design; check `trace.ts`).
- Auto Scaling group as a new resource kind (min, desired, max, subnets), drawn as an
  altocumulus cluster; launches and terminations take a few ticks.
- CloudWatch alarm (metric, threshold, OK/ALARM) that scales the group out and in.
- Events: `applyEvent(scene, event) → scene`, pure. `LevelEvent` in
  `src/levels/schema.ts` is currently `never`; crowd surge goes there first.
- Predicates: "at least N% of friendly kites delivered", "capacity back at minimum
  after the surge".
- The cost penalty for idle oversized instances belongs with this capacity model.
- Playback (`src/game/playback.ts`) currently plays one script per kite; crowds of 40
  need batching and throttled sound (brief, Sections 8 and 13).

**Level 6, Storm Front.** Needs AZ failure as an event (everything in the AZ becomes
unhealthy, including a NAT Gateway; the ALB stops routing there; the ASG relaunches
elsewhere), RDS as a resource (private subnets, subnet group across two AZs, engine
port from the app tier's security group, Multi-AZ failover over a few ticks, standby
serves no reads), and an instance → database flow in `flow.ts`.

**Smaller jobs, any time.**

- Load sprite files named in `assets/manifest.json` (currently only sizes are used).
- Delay the results card until the kites' endings have played.
- Disclose simplifications 11b and 13 on fact cards.
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
