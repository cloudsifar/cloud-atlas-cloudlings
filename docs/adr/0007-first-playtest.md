# 0007 — First playtest: placement needs aim, the narrator follows the sky

**Context.** Simon played Levels 1–5 on 18–19 November 2026, the first time a person
had played the game. As the brief's author he changed some of what the brief asked for.
This ADR records those changes, so the brief is not read as still saying otherwise.

**Decision.**

- **Placement needs aim** (replaces brief, Section 9: "the valid slots … are softly
  highlighted" and "every cloud snaps to its band" on any drop). While a cloud is
  dragged from the tray, no zone is shown until the pointer is over a zone where that
  cloud belongs; then that zone lights up. Letting go over a lit zone places the cloud
  there. Letting go anywhere else in the sky sends it back to the tray, with the gentle
  wobble and a message saying where it belongs. The zones are the same as before: valid
  subnet cells for subnet-bound clouds, otherwise the cloud's band (the low band down
  to the VPC border, the mid band inside the VPC, the high band, the S3 column).
  `dropZones` and `zoneAt` in `src/game/layout.ts`; tested in `tests/game/layout.test.ts`.
- **A click on a tray card no longer places the cloud.** It shows a message saying to
  drag it. Enter or Space still places it in its default spot, because a keyboard player
  cannot drag; a click from the keyboard has no pointer behind it (`event.detail` is 0).
- **Moving a placed cloud is unchanged**: dropped outside its zones, it drifts back to
  where it was and the explanation box returns (brief, Section 9).
- **The narrator follows the sky.** If the player undoes what a completed scene step
  asked for, the narrator goes back to the earliest such step, and the steps after it
  follow again as the player rebuilds (`rewindNarration` in `src/game/store.ts`, tested
  in `tests/game/store.test.ts`). Simon's case: removing Level 1's load balancer put it
  back with default settings and left the narrator on "Fly kites". Steps that were
  acknowledged, or that waited for a run, never go back. Scene steps must therefore be
  cumulative, which the existing level test ("the reference solution completes every
  narration step") already enforces.
- **Removal warnings.** A level may give a warning for removing a particular cloud
  (`removalWarnings`). Level 1 warns for the load balancer and the Internet Gateway; the
  config card shows the warning with "Keep it" (focused) and "Remove anyway".
- **Level 1 should leave no way to go wrong.** The changes above serve that: the
  narration names where each cloud goes, a wrong drop explains itself, and undoing work
  brings its guidance back.

Smaller changes from the same playtest:

- **Speech bubbles replace captions under the Cloudlings.** A clicked Cloudling says
  what it wants (`says` in each level's population); after a flight its kite's journey
  also opens, as before.
- **The high band is labelled "High – account"** (brief, Section 5: "High – managed
  services"). Simon asked for a word covering the account-level things that live there:
  IAM roles and policies belong to the AWS account, not to a network. Band labels now
  shrink to fit their band; the old label ran off the top of the sky.
- **Public and private subnets are tinted differently**, meadow green and lavender, never
  gold. The tint follows the route table, like the "public" caption, so a low-band subnet
  turns green when its Internet Gateway route is added. The subnet card's header carries
  the same tint.
- **The VPC's address range can be clicked** to open a CIDR card: what /16, /24, /28,
  /32 and /0 mean, the VPC and subnet size limits, and the five addresses AWS keeps in
  every subnet. The brief puts CIDR arithmetic out of scope; this card explains the
  notation and asks nothing of the player.
- **The menu can be opened over a level and closed again.** "Resume" carries on exactly
  where the player was, with a flight paused rather than skipped. Choosing a level from
  the menu still starts it afresh.
- **Sound levels:** the click and card sounds are louder, and the level-complete jingle
  is quieter.

**Consequences.**

- Scripts that play the game must drop clouds inside their zones. The headless
  playthroughs were updated (Level 3 dropped the bucket and role in the mid band, which
  now sends them back).
- Guided narration should name the band or spot for every cloud it asks for.
- Field Guide Part 3 (not yet built) should use "account" for the high band.
