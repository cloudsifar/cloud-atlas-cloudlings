# Progress

Running log. Newest state first; updated at the end of every milestone.

## Status

- [x] **Milestone 0** — plan, core types, ADRs
- [x] **Milestone 1** — engine core (routing, security groups, network ACLs, IAM, S3, load
      balancer target selection) with tests citing AWS docs; `docs/ENGINE.md`,
      `docs/SIMPLIFICATIONS.md`
- [x] **Milestone 2** — Levels 1–3 playable with placeholder art
- [ ] Milestone 3 — full engine, Levels 4–12
- [ ] Milestone 4 — shell (partly started: start screen, level select with ticks and stars,
      Guided Run from Level 1 with "Next level", settings)
- [ ] Milestone 5 — finish

## What was verified, and how

- **Tests:** 114 pass with `npm run offline:test` (the Vitest test files run on Node's
  test runner through a small stand-in for Vitest; see ADR 0002).
- **Type-check:** `tsc --noEmit` is clean apart from the two packages that could not be
  installed (`vitest`, `@types/node`).
- **In a browser (headless Chromium, 1280×720, esbuild bundle):** Levels 1, 2 and 3 were
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
  SQS, SNS, Lambda, KMS, SSM, Route 53, CloudWatch, cost, gateway endpoints as a
  placeable choice, EBS, EFS.
- Levels 4–12.
- Demo Mode, Field Guide, About screen, phone path, link
  preview tags, regional scenes beyond N. Virginia, costumes.
- `docs/ASSET_LIST.md`, `CREDITS.md`, font choice ADR (the game currently uses system
  font stacks; no font files are bundled).
- A smoke test that the production build renders the start screen.
- Weight budget check (the esbuild bundle is 125 KB before gzip; there are no art files).

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
