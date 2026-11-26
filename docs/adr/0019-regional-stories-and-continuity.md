# 0019 — A business for each region, and Level 8 carries Level 7's defences

**Context.** In Levels 1–8, the Cloudlings' requests were generic ("visitors", "a hat
shop"). Simon, after playing Level 7 and reading Level 8's plan:

- "Regional relevance and level continuity makes the game more enjoyable."
- "Hat is a bit boring. Maybe for the region it should be Havaianas flip flops, or a
  beachwear store where one cloudling wants flip flops and another wants to purchase a
  bikini."
- "I think levels 1-3 have a social media theme (good as it is set in US). 4-6 needs its
  own Frankfurt identity."
- "I think that level 8 should carry level 7's defences."
- He agreed to a Frankfurt book fair, and set the seasons: "springtime in Virginia,
  summer in Brazil, autumn in Germany and winter in Japan."

Level 8 started from Level 7's scene without its solution. The edge network ACL and the
WAF web ACL that the player had just built were missing, as if the shop had removed
them.

**Decision.**

**Stories.** Each region has one invented business and its season. The table is in
`docs/LEVEL_PLANS.md`.

- **Levels 1–3, N. Virginia in spring: Kitepost, a new photo-sharing app.**
  - 1: the app goes live.
  - 2: its feed is served from the mid band.
  - 3: users post cherry blossom photos to the bucket, and the red kite tries to read
    everyone's photos straight from it.
- **Levels 4–6, Frankfurt in autumn: the Mainufer Book Fair.**
  - 4: publishers upload catalogues and cover images to `catalogue-bucket`, and the red
    kite wants next season's covers early.
  - 5: the ticket rush on opening morning.
  - 6: the bookings database through the storm.
- **Levels 7–8, São Paulo in summer: Pé na Areia, a beachwear shop.** One green kite
  browses flip-flops and another buys a bikini.

The names are invented, so no trademark appears in the game. Changing a business means
editing its text in the level files.

**What changed in the level files.**

- Only the text, the Cloudlings' lines and a few display names changed. Display names
  are a resource's `name`, never its `id`, so tests and predicates are untouched:
  - Level 4's bucket is "catalogue-bucket" and keeps the id `photos`.
  - Level 6's database is "bookings database".
- Every changed narrator step still fits in about three lines (330 characters or
  fewer), so "Step x of y" stays in view. Steps that wait for a flight still say "fly"
  (the level test from ADR 0017).

**Continuity.** Where a region tells one story across its levels, a level starts from
the previous level's solved state. Inherited components are locked, because the lesson
is the new layer.

Level 8's initial and reference scenes now include Level 7's reference defences, locked:

- `edge-acl` on both public subnets:
  - inbound: deny 198.51.100.0/24 at 90, allow HTTPS at 100, allow ephemeral ports
    from the VPC at 200;
  - outbound: ephemeral ports at 100, HTTP to the VPC at 200.
- `shop-web-acl` on the load balancer, with the Core rule set and a rate-based rule of 100.

Level 8's text says why they don't help: S3 sits outside the VPC, so a network edge
doesn't cover it. Its concept now opens: "Access control and encryption at rest are
different defences, and a network edge does not cover S3".

**Consequences.**

- **What Level 8 now teaches.** The red reader, at 198.51.100.70 inside the block-listed
  range, still breaches the bucket. Its path in the trace has no network ACL or WAF step.
  This is the clearest form of the lesson: the previous level's defences are real, and
  in the wrong place for this attack.
- **Tests** (`tests/game/underLock.test.ts`, the block "Level 8 carries Level 7's
  defences"):
  - Level 8's edge ACL, its associations and its web ACL equal Level 7's reference
    solution;
  - they are locked;
  - the red reader breaches with neither check on its path.

  Every earlier Level 8 test passes unchanged. 422 tests in 26 files pass offline.

- **Probes repeated with the inherited defences, with the same results as before:**
  - Block Public Access alone works, and the bucket policy alone works;
  - SSE-KMS without `kms:Use` breaks the uploads;
  - `*` costs ★2, and `kms:Use` on the bucket is refused;
  - aws/s3 misses objective 3, and aws/rds misses ★3.
- **Played headlessly.**
  - Levels 1–7: every changed narrator text appears, and the step counter stays in view.
  - Level 8: replayed to three stars, with the inherited web ACL net, the `edge-acl`
    captions and the skyway caption drawn.
  - No console errors in either run.
- **Left as they were.**
  - ADR 0018 still says "the hat shop": it records the level as first built.
  - Level 2's `explain`, `chain` and `wrap` steps were already over three lines before
    this change and still scroll inside the narrator box (open decision 4 in
    `docs/LEVEL_PLANS.md`).
- **The plans for Levels 9–12 are in `docs/LEVEL_PLANS.md`:**
  - Level 9: SSH, then a bastion host, then Session Manager, with the operator's address
    changing as a twist. An "In the real world" card covers the VPC endpoint DNS
    settings.
  - Tokyo's business, still to choose.
