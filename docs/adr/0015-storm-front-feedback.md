# 0015 — After Storm Front's first play: settled runs end, bold place letters, one cloud per instance

**Context.** Simon played Level 6 on 25 November 2026 and asked for four changes:

1. "After the kites drop to the ground the simulation is over anyway and the next button
   should appear in the steps window", rather than pressing Stop.
2. "References to AZ a and AZ b should have the letters in bold. Make that a universal
   rule. When individual subnets are referred to by letter in a text box, that letter
   must be bold."
3. "On the final step, there should be a hint to the user about raising the fleet
   minimum in order to obtain the 3rd star."
4. "When there are 2 instances you show 4 balls, 4 instances = 8 balls. It should be a
   direct correlation visually 4=4 objects in the cluster. The graphics will be
   substituted in future anyway, but I want the logic in place now."

**Decision.**

1. **A settled run ends on its own** (`settledFrom`, `playedTicks` in
   `src/game/crowdPlayback.ts`).
   - **When a day has settled.** From some minute to the end, no kite is answered and
     nothing changes: no zone, database, fleet, crowd or outcome. The journeys
     themselves are left out of the comparison, because they take turns between
     targets.
   - **What happens then.** The playback stops `SETTLED_TICKS` (2) minutes after the
     day settled, so the kites are seen to fall and stay down. The run then finishes as
     usual, so a `run-finished` narrator step advances and Next appears.
   - **Only when it is worth it.** A day is cut only when this saves at least four
     minutes.
   - **What the player sees.**
     - The clock ends on the last minute played.
     - The weather station says that the run stopped early, and that the rest of the
       day would have gone the same way.
   - **What does not change.** The engine's record and every objective still cover the
     whole day.
   - **In Level 6.** The unsolved run now settles at minute 8 and ends after minute 10,
     about 18 s in.
   - **Unchanged.** The solved runs and every Level 5 run, which never settle (tested).
2. **Zone and subnet letters are bold everywhere.**
   - **One rule for both surfaces.** `letterSegments` (`src/levels/markup.ts`) finds the
     letters in:
     - "AZ a", "AZs a and b" and "Availability Zone b";
     - "Private subnet A" and "subnets A and B".

     The interface and the sky's captions both draw from it.

   - **The interface.** `installPlaceLetters` (`src/ui/dom.ts`) is installed once on
     the page. It watches for new text, however that text got there, and wraps each
     match in a `span.place-text` containing a `strong.place-letter`. The single wrapper
     keeps flex labels spaced as before.
   - **Left plain.** Dropdown options, form fields and SVG, which cannot hold bold.
   - **The sky.** `caption` in `render.ts` lays a caption out piece by piece, with the
     letter in bold.
   - **Lower-case zones.** Zone letters are now lower case throughout, as in
     eu-central-1a. The engine's trace messages, the weather station, the CloudWatch log
     and the database's captions all said "AZ A" before. A level test rejects
     upper-case zone letters in levels and fact cards.
3. **The last step hints at the third star.**
   - Level 6's final step now says what the third star asks for: raise the web fleet's
     minimum to 4, two instances per zone, so AZ b alone can carry the crowd. It links
     to the static stability card.
   - It pulses the fleet card's new `group-size` section (Minimum instances).
   - The step was shortened to fit the narrator's box: three lines, about 340
     characters. `docs/LEVEL_AUTHORING.md` now states that limit.
4. **One cloudlet per instance in a fleet.**
   - A fleet's instances were each drawn with the altocumulus silhouette, a patch of
     several cloudlets, so a picture of two instances showed four or more shapes.
   - Each instance is now one `cloudlet`: a single outlined shape. `fleetMembers` gives
     one entry per instance, in drawing order. The fleet always keeps a place for every
     instance, so none is left undrawn.
   - The cloudlet has its own sprite, `cloud.altocumulus.fleet-instance` (64 × 40, its
     largest size), so final art can replace it without code changes.
   - Tested: at every half minute of the solved storm, each zone draws exactly as many
     cloudlets as it has instances.

**Consequences.**

- **Tests.** The suite has 318 tests on the offline runner. New ones cover:
  - the settled-run cut;
  - letter finding, including the words that must stay plain;
  - lower-case zones in shipped text;
  - the one-to-one fleet count.
- **Not changed.** A standalone EC2 instance (Levels 2–5) is still drawn as a patch of
  four cloudlets. Simon decided on 25 November 2026 to keep it, since it reads as one
  cloud. The rule for the final art: one EC2 instance is one EC2 graphic
  (`cloud.altocumulus.ec2-instance`), and a fleet is made of the smaller cluster
  graphic (`cloud.altocumulus.fleet-instance`), one per instance.
- **Not covered by the bold rule.** Text in a dropdown option stays plain: an option
  cannot hold bold text.
