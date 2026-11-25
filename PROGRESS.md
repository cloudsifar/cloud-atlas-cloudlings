# Progress

Running log. Newest state first; updated at the end of every milestone.

## Status

- [x] **Milestone 0** — plan, core types, ADRs
- [x] **Milestone 1** — engine core (routing, security groups, network ACLs, IAM, S3, load
      balancer target selection) with tests citing AWS docs; `docs/ENGINE.md`,
      `docs/SIMPLIFICATIONS.md`
- [x] **Milestone 2** — Levels 1–3 playable with placeholder art
- [ ] **Milestone 3** — in progress: Levels 4 (Skyway), 5 (Crowd Day) and 6 (Storm Front)
      finished; Levels 7–12 and the rest of the engine to do. See "Handover: what to build next" below
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
  - Level 5, rebuilt (ADR 0012), on the esbuild bundle, 25 November 2026:
    - The unsolved run: 34 of 40 Cloudlings timed out; the worst minute had 30 of 40
      kites with no room.
    - Simon's case: a group of eight large instances with a 50% policy, never ticked as
      a target. Its card warned, the sky captioned it, the dots went only to the fixed
      instances, and the result was the same as with no group at all.
    - The guided solution through the interface: place the group, minimum 2, maximum 16,
      50%, tick it as a target, remove both fixed instances. The fleet was seen at 2, 4,
      8 and 16 and back down, with the log reading as expected minute by minute. The
      level was completed with three stars, and every narrator step advanced.
    - No console errors in any of these runs.
  - Level 6, Storm Front (ADR 0014), on the esbuild bundle, 25 November 2026:
    - The unsolved run: 8 of 8 Cloudlings timed out from minute 8. The weather station
      said no healthy targets, that the fleet had nowhere to launch replacements, and
      that the database went down with its zone. "Follow a kite with no healthy
      instance to answer it" opened a trace ending "is in Availability Zone a, which is
      down … times out".
    - The fleet spread to both subnets, nothing else: AZ b's instance was turned away by
      the database's 10.0.11.0/24 rule from the first minute ("✕ turned away here" at
      the database), and the database went down with AZ a at minute 8.
    - The guided fix through the interface: Private subnet B ticked on the fleet card,
      minimum raised to 4, Multi-AZ ticked, MySQL from `ec2-app-sg` added on
      `rds-db-sg` and the address-range rule removed. Every narrator step advanced. The
      storm played over minutes 8–11 in slow motion (the run took 44 s): lightning
      over AZ a, the database failing over with lightning between primary and standby,
      replacements launching in AZ b. Only the two failover minutes failed. Both
      objectives and all three stars, and the completion card listed the four fact
      cards.
    - Level 5 replayed to minute 10 afterwards: unchanged.
    - No console errors in any of these runs.
  - No console errors in any of the earlier runs.

## Not verified — do these first

1. **Vitest, the Vite build and lint on Windows, on everything since 18 November**
   (ADRs 0007–0014). In that time the suite has run only on the offline runner
   (308 tests), and ESLint, Prettier and the project `tsc` were run against the
   installed packages from the cloud sandbox. On Windows, after `git pull`:
   `npm ci --ignore-scripts`, then `npm test` (expect 21 test files and **308 passed**),
   `npm run build` (writes `dist/`, including `dist/sounds/README.md`) and
   `npm run lint`. Read each output, not only the exit code.
2. **Level 6 played by a person** (ADR 0014): whether the storm's slow-motion minutes
   are slow enough to follow, whether the database's primary, standby and failover
   read clearly, whether the security group trap is fair, and how the new `thunder`
   and `failover` placeholder sounds land. Level 5 (ADR 0012) was played by Simon on
   25 November and works.
3. **A person playing it again.** Simon played Levels 1–5 in a real browser on
   18–19 November; his changes are in ADR 0007. They need his eye: how dragging feels
   now, the sound levels, the subnet tints, the speech bubbles, Resume.
4. Firefox, Safari and Edge. Only Chromium was tried.
5. Window sizes other than 1280×720, tablets, and the phone path.
6. Sound. The synthesised placeholders exist but headless testing cannot hear them.
   The new `level-dissolve` placeholder (ADR 0011) and the per-objective tick sounds
   have not been heard by anyone. Playing a recording from `public/sounds/` is written
   but untested with a real file: when Simon's dissolve recording arrives, set its
   `file`, run `npm run dev`, press "Next level" and listen; the console warns if it
   fails to load.
   Simon heard them in the first playtest: the click and card sounds were too quiet and
   the level-complete jingle too loud, now adjusted (ADR 0007). Level 5's four crowd
   cues and their blending have only been checked in code.
7. Frame rate with a crowd of 40 on a modest laptop or tablet. Chromium on the build
   machine was smooth; nothing was measured.
8. The AWS documentation links cited in the test files. Five behaviours were re-checked
   against the current AWS docs during the build (ALB health checks and fail-open, S3
   Block Public Access, network ACLs and ephemeral ports, IAM policy evaluation, route
   priority and gateway endpoints), and for Level 5: target tracking scaling, Auto
   Scaling capacity limits (desired between minimum and maximum), and ALB HTTP 504
   when a busy target does not answer in time. The other links were not each opened:
   click through them once.

## Known issues

- **ESLint 9 is past end of life** (6 August 2026). Upgrading to ESLint 10 and
  `@eslint/js` 10 is a separate major change; not needed for any advisory.
- **Asset swapping is half built.** Sounds are done: an effect in `assets/sounds.json`
  with a `file` plays that recording from `public/sounds/` (ADR 0011). Sprites are not:
  `assets/manifest.json` sets each sprite's size and anchor, but the renderer does not
  yet load image files, so setting `file` there has no effect. Placeholders are always
  drawn in code.
- **Label overlaps** in the low band: the load balancer's caption runs into the
  "public: routes to the Internet Gateway" notes and sits close to the gateway cloud.
- New security group rules default to HTTPS 443 in the port dropdown; Level 2 needs
  HTTP 80, which is easy to miss. The narrator names the port, and the step does not
  advance until the right rule exists.
- Level 5: while the two fixed EC2 instances are still in the sky, the fleet sits
  between them and its instances are drawn small; removing the fixed instances (as the
  narrator asks) gives it both subnets. During a crowd run the kites cover the Internet
  Gateway's label.
- Level 5: clicking one of the four named Cloudlings after a crowd run opens _its own_
  journey, flown at a quiet moment, so it is always delivered when the network is
  right. The crowd's journeys (timed out, or got through at the busiest tick) are
  opened from the weather station's "Follow a kite…" links. The same holds in Level 6:
  a named Cloudling's own journey is flown before the storm.
- Level 6: the load balancer is one cloud across both zones, so in the storm only its
  left half is greyed; its node in AZ a is out of service, which the CloudWatch log and
  the trace say in words.

## Not started (from the brief)

- Engine: WAF, instance failure outside an AZ failure, RDS encryption and read replicas,
  DynamoDB, SQS, SNS, Lambda, KMS, SSM, Route 53,
  CloudWatch alarms other than a scaling policy's (e.g. publishing to SNS), EBS, EFS,
  DynamoDB gateway endpoint flows, and the cost penalty for idle oversized instances.
- Levels 7–12.
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

**Level 5, Crowd Day: rebuilt (ADR 0012, 25 November 2026).** What the level now does:

- Each Cloudling keeps one kite up; the crowd's size is the load. Small, medium and large
  instances have room for 5, 10 and 20 kites; CPU is kites ÷ room.
- The crowd arrives in groups (crowd waves on the timeline): 4 → 9 → 19 → 40 at minutes
  2, 6 and 10, then home the same way. A minute is 1.25 s, so groups are 5 s apart and a
  run lasts about 34 s.
- Target tracking scales out at once in proportion, and scales in after two low minutes,
  at most half the fleet at a time. The reference fleet goes 2 → 4 → 8 → 16 → 8 → 4 → 2.
- A group that is not a load balancer target gets no kites and never scales; its card,
  its caption and the weather station all say so. This was why Simon always saw 226 of
  552 delivered.
- Every kite flies on a long string up to the load balancer (ADR 0013): attached while
  it has room, knocked loose and lying on the ground while it has none, attached again
  when there is room.
- The fleet is drawn instance by instance, half in each Availability Zone, launching ones
  dashed, removed ones fading. CloudWatch stands at the bottom right with a larger dial
  that moves smoothly and marks the target, a bell, and a readout. The side panel shows
  CloudWatch's log live, one line per change.
- Objective: every kite answered all day. This changes the brief's "at least 95% during
  the surge", because a single clear outcome reads better with one kite per Cloudling;
  Simon can revert it (`percent` in the level file). Third star, "sized to demand": CPU
  at least 30% before the crowd, two Availability Zones throughout, and the fleet grows
  and shrinks. Two large instances, or eight of anything, all day pass the objective but
  not the star.
- Narration is guided: eight steps, from the first run to the wrap-up.

Still not done for Level 5, and left for later milestones:

- The four regional costumes are still a tunic colour only (Milestone 5 art).
- Idle oversized instances now cost the third star (CPU at least 30% before the crowd),
  but not coins: instance-minutes are not costed. That can come with cost scoring
  (Level 12).
- A speed control for crowd runs: the slow pace is deliberate, but a replay at 2× would
  help once the player knows what to watch.
- The Field Guide entries for the new signs (bell, slack string, crowd) — Milestone 4.

**Level 6, Storm Front: built (ADR 0014, 25 November 2026).** What the level does:

- Eight Cloudlings look up their orders: load balancer → web fleet → orders database
  (RDS for MySQL). The fleet and the database start in AZ a only, and AZ a fails at
  minute 8.
- Three fixes, one narrator step each: spread the fleet over both subnets, make the
  database Multi-AZ, and chain its security group to `ec2-app-sg`. The third is a trap:
  the database starts by allowing MySQL from Private subnet A's range only, so a spread
  fleet's AZ b instances are turned away.
- Objectives: at least 90% answered through the storm, and every kite answered at the
  end. Third star, static stability: no kite fails outside the failover, which needs a
  minimum of 4 (two per zone).
- The storm's minutes play three times slower, so the strike, the failover and the
  replacements can be followed (15 s); the rest keeps Level 5's pace.

Still not done for Level 6, and left for later milestones:

- The four fact cards' `atlasPage` links are `TODO(Simon)`, like every card.
- `thunder` and `failover` are synthesised placeholders.
- A replay speed control would now help on both crowd levels.

**Level 7, The Wrong Kite (next).** Brief, Section 6. Needs WAF (a web ACL on the load
balancer with the Core rule set and a rate-based rule), custom network ACLs on the
public subnets with rule order that matters, and three kinds of red kite: a known bad
range, a malicious payload, and a flood. The engine already evaluates network ACLs in
rule order with ephemeral ports (section 6 of `docs/ENGINE.md`); WAF is new, and a
flood needs a hostile crowd or a rate count on the timeline.

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
- **Session 3, continued: "over here" and headings.** In Levels 1–3, the heading of the
  card section the narrator is asking about now pulses until the step is done (route
  table, security group, listener, targets, role statements, instance role), checked
  by a level test. Headings are bold and upright, not the handwritten face, and no
  italics remain. Press Start 2P (OFL) is proposed for headings, waiting on the font
  file. ADR 0008. 206 tests pass offline.
- **Session 3, continued: honest attackers.** Level 2's red kite now tries SSH 22 at the
  load balancer and is turned away by `alb-sg` (it used to aim at a private instance
  address, which no attacker could). `docs/THREATS.md` audits every level's attacker; a
  test checks red kites only aim at public endpoints. A stopped red kite gets a green
  shield, not a red cross. Security groups say who wears them; the instances' group is
  `ec2-app-sg`. Narration says "EC2 instances". A "What is a listener?" card covers
  certificates. Results wait three seconds. The sky's captions are upright. Titles are
  set in Press Start 2P (OFL, bundled in `assets/fonts/`). ADR 0009.
  211 tests pass offline.
- **Session 3, continued: between levels.** "Next level" now dissolves the old sky into
  blurred pixels for two seconds, shows the new level's number and name at 48 px in
  Press Start 2P, then sharpens into the new sky. From the menu a level starts at the
  title. Reduced motion shows the title only. ADR 0010. Checked headlessly: frames
  through the dissolve, title and reveal; the filter is gone afterwards.
- **Session 3, continued: one tick at a time.** When the kites land, the objectives
  now tick one by one, a second apart, in the level's order, the summary objective
  last; the stars wait for the last tick and the results card still opens at 3 s.
  The dissolve has a 2 s placeholder sound, and recorded sounds can now replace any
  placeholder. Narration can link a phrase to a fact card (`[phrase](card:id)`, checked
  by the validator); Level 2's "bastion host" opens a new card on bastion hosts and
  Session Manager. Level 3 says "the S3 cloud"; Level 4's summary line was reworded.
  Long narrator steps scroll. ADR 0011. 225 tests pass offline. Checked headlessly:
  Level 2's link opens the card, ticks land at 0, 1 and 2 s, results at 3 s, and the
  Level 2 → 3 transition runs without console errors. Open question for Simon: how data
  should move between clouds (ADR 0011 does not decide it).
- **Session 3, continued: Crowd Day rebuilt.** Simon found Level 5 broken: always 226 of
  552 kites, whatever the fleet. The cause was a group never attached to the load
  balancer, with nothing saying so; an unattached group also scaled on other targets'
  CPU. Rebuilt around one kite per Cloudling and groups arriving 5 s apart (4 → 9 → 19 →
  40 and back). Scale-in is more gradual than scale-out, at most half the fleet at once.
  The fleet is drawn instance by instance in two Availability Zones; the CloudWatch dial
  moves smoothly and the side panel shows its live log. The third star is "sized to
  demand", and narration is guided. ADR 0012. 266 tests pass offline; played headlessly
  unsolved, unattached and solved.
- **Session 3, continued: kites reach the load balancer.** At Simon's request every crowd
  kite now flies on a long string up to the load balancer: attached means answered;
  knocked loose and fallen means no room, as kites behave in the other levels. Simon's
  own Level 4 summary edit was pulled in first. ADR 0013. 267 tests pass offline; played
  headlessly, unsolved and solved, with no console errors.
- **Session 3, continued: Level 6, Storm Front.** RDS (MySQL/PostgreSQL, DB subnet
  group, Multi-AZ failover in two minutes), an `az-failure` event, health-check
  replacement in a zone that is up, load balancer nodes leaving a failed zone, NAT
  Gateways failing with their zone, and a crowd shared between targets by room. Five
  predicates. The sky draws the storm, the fleet by zone and the database's primary,
  standby and failover; the storm's minutes play slower, after Simon's Level 5 lesson
  that a level is not a race. Fact cards for RDS and static stability. ADR 0014;
  SIMPLIFICATIONS 30–37. 308 tests pass offline; played headlessly unsolved, half
  solved and solved to three stars, no console errors.
