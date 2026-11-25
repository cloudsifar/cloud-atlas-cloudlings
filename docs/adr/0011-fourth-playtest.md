# 0011 — Objectives tick one at a time, the dissolve has a sound, narration links to cards

**Context.** Simon asked (24 November 2026) for five changes after playing the level
transition (ADR 0010):

1. The dissolve between levels gets its own sound, which he will record. It lasts as
   long as the dissolve: "boop-boop-boop, not a single boop".
2. In Level 2, step 3, "bastion host" should be blue and underlined, and open a card
   that explains bastion hosts.
3. When a run ends, the objectives should tick one at a time, each as the animation
   shows it happening, about a second apart, with the level's final objective last.
4. In Level 3, step 2, "the S3 column" becomes "the S3 cloud".
5. Level 4's summary line, "Reaching S3 privately through a gateway endpoint, and why a
   NAT Gateway you do not need is money spent", needed its grammar fixed.

**Decision.**

- **Objectives tick in turn.** The run lands only after every kite's ending has played
  (`runDuration` in `src/game/playback.ts`), so the first objective ticks at the
  landing, as the last animation finishes. Each later objective ticks
  `OBJECTIVE_TICK_MS` (1 s) after the one before, in the order the level file lists
  them. Every level already lists its summary objective last (Level 2's "accept
  traffic only from the load balancer's security group", Level 4's "travels by gateway
  endpoint"), so that is the rule for authors too. An objective that ticks and is met
  plays the tick sound; one that is not met stays ☐ and offers its hint. One still
  waiting to tick shows no hint, since it may be about to tick. The stars and the
  "what to improve" findings wait until the last objective has ticked. The results card
  opens at `resultsDelay(n)`: 3 s as before (ADR 0009), or one tick after the last
  objective when a level has more than three. Editing, undoing or flying again cancels
  any ticks still to come. The schedule is pure and tested (`src/game/reveal.ts`,
  `tests/game/reveal.test.ts`). Checked headlessly on Level 2: ticks at 0, 1.0 and 2.0 s
  after landing, stars at 2.0 s, the results at 3.0 s.
- **Why not tie each tick to its own kite?** Objectives are predicates over the whole
  run, not over one kite: "every green kite is delivered" is true only when the last
  green kite lands, and Level 2's third objective is a property of the security groups
  that no single kite shows. Ticking from the moment everything has landed means a box
  never ticks before its evidence has been seen.
- **The dissolve sound.** `level-dissolve` in `assets/sounds.json` is a placeholder of
  eight short falling square-wave notes, one every 0.25 s, lasting 2.0 s in all, the
  same as `DISSOLVE_MS` in `src/ui/transition.ts`, which plays it as the dissolve
  starts. Reduced motion has no dissolve, so no sound.
- **Recorded sounds can now be used.** `src/game/sound.ts` loads a recording for any
  effect whose entry in `assets/sounds.json` has a `file`, from `public/sounds/`
  (copied to `dist/sounds/` by both builds), and plays it instead of the synthesised
  tones. If the file is missing or will not decode, the placeholder plays and a warning
  is logged. Volume settings apply to recordings as to tones.
- **Narration can link to fact cards.** A step's text may contain
  `[phrase](card:fact-card-id)`; the narrator shows the phrase as an underlined blue
  link that opens the card. The validator rejects a link to a card that does not exist.
  `src/levels/markup.ts`, tested in `tests/levels/markup.test.ts`.
- **The bastion host card** (`concept-bastion-host`): what a bastion (jump box) is, how
  its security group and the private instances' security group chain, that each hop
  needs SSH keys the red Cloudling does not have, that a bastion must itself be
  patched and watched, and that Systems Manager Session Manager removes the need for
  one. Source for the last point: AWS says Session Manager gives access "without the
  need to open inbound ports, maintain bastion hosts, or manage SSH keys"
  (https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html).
  No level contains a bastion, and the card says so.
- **Wording.** Level 3: "…where it becomes the S3 cloud: S3 stands outside your VPC and
  spans every altitude." Level 4, in Simon's words (25 November): "This shows you how to
  reach S3 privately through a gateway endpoint, and that paying for a NAT Gateway you
  do not need is not cost efficient. A NAT Gateway is not needed in this scenario:
  remove it and save money."
- **Long narrator steps scroll.** The narrator box is 84 px tall; Level 2's step 3 ran
  past the bottom of a 720 px window, hiding "Step 3 of 7". The text now scrolls inside
  the box.

**Consequences.** A complete level shows its results 3 s after landing, as before, for
every shipped level (none has more than three objectives). Simon's recording replaces
the placeholder by dropping a file in `public/sounds/` and setting `file`; nothing else
changes. Narration links are the first rich text in level files; anything else in a
step is still plain text.
