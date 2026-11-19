# 0008 — "Over here": pulsing card sections, and upright headings

**Context.** Second round of Simon's playtest feedback (19 November 2026). In Level 1,
step 6, the player has to add an inbound rule to the load balancer's security group,
and nothing on the open card says where. The same happens at every step in the
beginner levels that asks for a setting to change. Separately, headings were set in the
handwritten caption face; on Windows that falls back to Segoe Print, which reads as
italic, and three notes were set in true italics.

**Decision.**

- **A narrator step can name card sections to pulse** (`pulse` in a narration step,
  e.g. `["security-group:sg-alb"]`). While that step is current, the heading of each
  named section on an open card swells a little, glows blue and gains a ◀, until the
  step is done. Blue, because gold means only "a change took effect". With reduced
  motion it glows without moving. The sections are listed in `PULSE_SECTIONS`
  (`src/levels/schema.ts`): a security group, a route table, a load balancer's listener
  or targets, a role's statements or wearers, an instance's role.
- **Levels 1–3 pulse every setting they ask for.** A level test checks it: in a
  beginner level, every scene step whose predicate is not "a cloud exists" must name
  at least one section. (Placing a cloud is covered by the tray highlight.)
- **Headings are upright and bold**, a step larger than the text under them: panel and
  card headings, level tiles, tray names, trace headings, the results card, and the
  main buttons. They use `--heading-font`, the body face for now. No italics anywhere in
  the interface. The handwritten face stays only for the explanation note, the
  start-screen tagline and the captions drawn in the sky.
- **A 1990s pixel font for headings is proposed, not yet added.** Simon pointed at
  codeman38's fonts. Press Start 2P is the candidate: it is under the SIL Open Font
  Licence, so it can be shipped in this public repository, and it is drawn for 8, 16
  and 24 px. It would only be used for headings, never body text, for legibility. It
  needs the font file from Simon (the sandbox cannot download it); `--heading-font` is
  the one place to switch.

**Consequences.**

- Guided levels from Level 4 on can use `pulse` too; only Levels 1–3 are required to.
- A pixel font at 16 px is wide: long card titles ("Application Load Balancer") will
  wrap. Check the cards when it goes in.
