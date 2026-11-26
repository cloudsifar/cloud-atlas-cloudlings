# 0017 — Level 7, The Wrong Kite: AWS WAF, network ACLs the player writes, and layers of defence

**Context.** The brief's Level 7 (Section 11) teaches that no single control sees every
attack. Its outline:

- **The scene.** A working web tier.
- **The red kites.** Three: one from a known bad range (198.51.100.0/24), one with a
  malicious payload on 443 from an ordinary address, and one flooding requests.
- **The player's work.** Add a custom network ACL to the public subnets (deny the
  range, allow 443 in, allow ephemeral ports out), and attach a WAF web ACL with the
  Core rule set and a rate-based rule.
- **The trap.** Forgetting the outbound ephemeral rule lets requests in but drops
  every response.
- **★3.** "NACL rules ordered so the deny is evaluated before the allow."

The engine had network ACLs, but every level used only the VPC's default one, with no
way to edit it. It had no WAF at all. Simon's lesson from Level 5 still applies: "allow
enough time between events so that the user can process what is happening and
understand it. The level is not a race."

**Decision.**

The level (`levels/07-the-wrong-kite.json`, São Paulo, sa-east-1, guided with hints):

- **The starting sky.** A shop in two zones: an Application Load Balancer in the public
  subnets, web servers A and B in the private subnets, and security groups that are
  already right. Three visitors browse. Three red Cloudlings come too:
  - one from 198.51.100.66, a block-listed range, with a clean request;
  - one hiding a script in a review;
  - one flooding: 3,000 requests in five minutes, drawn as a flock of kites.

  All three red kites reach a web server on the first run: three breaches.

- **The custom network ACL is already there.** The VPC has `edge-acl`, made for the
  public subnets: an inbound rule for the web servers' replies (200: ephemeral ports
  from the VPC) and an outbound rule for the requests to them (200: HTTP to the VPC).
  It is not yet associated with any subnet. The player switches each public subnet to
  it on the subnet's card, then writes the rules there. This differs from the brief:
  - **What differs.** The player cannot create the ACL from the tray. A network ACL is
    not a cloud in the sky but a fence around subnets, so it has no place to be
    dropped.
  - **What it still teaches.** What creating one in AWS teaches: a new custom ACL
    denies everything until it has rules.
- **Nine narrator steps, one change and one flight each.**
  1. A first run: all three attacks get in.
  2. Why: a security group can only allow, and neither it nor a network ACL can see
     inside a request.
  3. Switch both public subnets to `edge-acl`, then fly. Every kite is tangled in the
     ribbon, because a custom ACL denies whatever it has no rule for.
  4. Add inbound 100: allow HTTPS from anywhere, then fly. The brief's trap follows: the
     requests get in, and every reply is dropped on its way out.
  5. Add outbound 100: allow ephemeral ports to anywhere, then fly. Visitors are
     answered, but so is the block-listed range.
  6. Add an inbound deny for 198.51.100.0/24, numbered below 100, then fly. The step
     explains why a deny numbered after the allow is never read. Played through: a
     deny at 110 leaves the step where it is; at 90 it moves on.
  7. Drag the WAF web ACL from the tray, then tick the Core rule set and a rate-based
     rule on its card.
  8. Fly: the net beneath the load balancer catches the script and the flood.
  9. Wrap-up, linked to the Well-Architected card "Security at every layer", with the
     third-star hint.
- **Steps that wait for "change, then fly".** A `run-finished` trigger may now carry a
  predicate. The step moves on only after a run of the current scene that satisfies it
  (`lastRunIsCurrent` in `store.ts`). An old run does not count, nor does a change
  without a flight. This is what lets each step show the result of its own change.
- **Objectives**, in the order they happen:
  1. The block-listed range is stopped by a network ACL.
  2. The script is stopped by WAF.
  3. The flood is stopped by WAF.
  4. Every visitor is answered, reply included.
- **★3: rule numbers with room between them, not "deny before allow".** In this level a
  deny after the allow is never read, so the range gets in. Ordering the deny first is
  therefore already required by objective 1, and cannot also earn a star. The third star
  asks instead for what AWS recommends in the CreateNetworkAclEntry reference: rule
  numbers at least 10 apart (`network-acl-rules-spaced`, gap 10), as in 90, 100, 110,
  so a rule can be added between two others without renumbering.
  - The reference solution numbers its rules 90, 100 and 200.
  - Numbering the deny 99, or 1, still meets every objective but misses the star
    (probed).
- **The rate limit is the player's choice.** The card offers 100, 500, 2,000 or 10,000
  requests per five minutes, and says an ordinary visitor sends about 20. The flood
  sends 3,000. So 10,000 lets it through (probed), and 100 to 2,000 stop it.

The engine (`docs/ENGINE.md`, section 16):

- **Web ACLs.** `waf-web-acl` resources, read after the listener and before target
  selection, with an IP set, a rate-based rule and the Core rule set, in that order.
  A block is 403 Forbidden, and a request no rule blocks takes the default action.
  The brief's Section 7 puts WAF before the listener. The engine follows AWS: a
  request's content can be read only once a listener has accepted the connection and
  terminated TLS (recorded under "Conflicts" in `PROGRESS.md`).
- **Breach.** Any hostile kite that reaches a target is a breach. Before this, only one
  carrying a malicious payload was. A flood that gets through, or a clean request from a
  block-listed range, has also done what it came for.
- **Least privilege for network ACLs.** On a custom ACL the player can edit, every
  allow rule must be one some kite relied on, and must not open all traffic. The
  default ACL (`isDefault`, now marked in every level) is not judged.
- **Validation.** Network ACL rule numbers run from 1 to 32766. Each load balancer has
  at most one web ACL. A rate limit is at least 10.

The interface:

- **Network ACLs on a subnet's card.**
  - Which ACL the subnet uses.
  - The rules in each direction, each with a remove button.
  - A row to add one: a number, allow or deny, a port option and a peer.
  - A reason, said aloud to screen readers, when a rule cannot be added (a number
    already used, or out of range).
- **The web ACL's card.** What it protects, its default action, a checkbox for each
  rule, and the rate limit.

The sky:

- **The network ACL ribbon.**
  - A custom ACL's ribbon is drawn stronger, with its name in the subnet's corner.
  - A kite it stops is drawn tangled in the ribbon.
- **The WAF net.**
  - It hangs beneath the load balancer, with its name beside it.
  - A kite it stops is drawn netted, then crumples and falls.
  - The load balancer's caption moves inside its cloud while a net hangs there.
- **Where a network ACL check is drawn.**
  - It sits where the path crosses the subnet's fence, on the side it crosses
    (`placeSteps` in `playback.ts`). A reply dropped on its way out of a public subnet
    is drawn on the edge facing the internet, not on the edge it came in by. Before,
    the drop in step 4 appeared on the top edge, which pointed the player at the wrong
    fence.
  - A reply passes back through the load balancer between its two checks at the public
    subnet.
  - Tested in `tests/game/playbackPlaces.test.ts`.
- **One label per stop.** Several kites stopped at one stretch of fence share one
  label. Six "Network ACL" captions on top of each other were unreadable.
- **The "✓ public" labels.** They sit in each public subnet's outer corner, away from
  the load balancer that spans the middle.
- **The placement tip.** It no longer opens under a config card. When the card covers
  its side, the tip goes below the cloud.

**Consequences.**

- **Tests.** The offline runner has 367 tests:
  - `tests/engine/waf.test.ts` covers web ACL rules, their order, the breach rule,
    validation, the edge ACL, scoring and the new predicates, and cites the AWS
    documentation for each;
  - the solvability tests play the reference solution and the guided path's traps;
  - `tests/game/playbackPlaces.test.ts` checks where the checks are drawn.
- **Played through headlessly** in the built game, every step by the interface:
  - associating the subnets, adding and removing rules, dragging in the web ACL and
    ticking its rules;
  - the narrator moved through all nine steps as designed, and the run ended with all
    four objectives and three stars;
  - there were no console errors.
- **Simplifications** are rows 38–44 in `docs/SIMPLIFICATIONS.md`:
  - the fixed rule order;
  - a flood's rate given per Cloudling;
  - the Core rule set recognising every malicious payload;
  - no logging, Bot Control or CAPTCHA;
  - no limit on rules per ACL;
  - the default ACL not scored;
  - crowds never meet a web ACL.

  The `waf-web-acl` and `network-acl` fact cards disclose the ones players meet.

- **Threats.** The three red kites are in `docs/THREATS.md`.
- **Still to check on Windows with npm:**
  - `npm test` and `npm run build`, expecting 367 tests in 24 files;
  - ESLint and Prettier;
  - the new `blocked-waf` sound by ear.
