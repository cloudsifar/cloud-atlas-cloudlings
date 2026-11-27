# 0020 — Level 9, No Keys at the Door: a bastion host, then Session Manager

**Context.**

- **The brief's Level 9 (Section 11).** A working app has a leftover SSH 22 rule from
  0.0.0.0/0, and an operator Cloudling (distinct hat, box kite) needs a shell on an
  instance. The player removes the rule, adds Session Manager, gives the instance role
  `ssm:ManagedInstance` and provides an outbound path through a NAT Gateway.
  - **Objectives:** the operator gets a session, drawn from the cirrocumulus down to
    the instance; no inbound port 22 anywhere.
  - **★3:** no security group or network ACL anywhere references port 22.
- **Simon reworked the story (26 November 2026):** "the admins need it open, so they
  open it, restrict it to their own IP, but still the attacker is probing. There's a
  better way. Close port 22 again and use SSM." He also wanted:
  - the twist where the admin's address changes;
  - the NAT Gateway route, with the interface-endpoint DNS details on a clickable card
    rather than for the player to configure;
  - the shop and edge from Levels 7–8 (ADR 0019).

  The agreed plan is in `docs/LEVEL_PLANS.md`.

**Decision.**

**The level** (`levels/09-no-keys-at-the-door.json`, São Paulo, hints). It starts from
Level 8's solved shop, which includes Level 7's `edge-acl` and web ACL. `edge-acl`,
`ec2-app-sg`, `app-role` and the private route table are open to edit; the rest is
locked. The player takes 15 narrator steps:

1. Fly: nothing has a public address, so the hooded Cloudling's SSH probe has nothing
   to knock on, and the operator has no way in either.
2. Place the bastion host in Public subnet A, then fly.
3. Then add, flying after each:
   - edge-acl rules for SSH in from the operator's address and out to the VPC;
   - bastion-sg's SSH rule from the operator's /32;
   - ec2-app-sg's SSH rule from bastion-sg.

   Each flight shows the next control that stops the operator. The operator gets a
   shell, and the narrator counts what it cost.

4. The twist: the operator works from the coast, from a new address, and is locked out.
   The narrator names the "anywhere, just for today" temptation without asking the
   player to make it.
5. Place Session Manager, and allow `ssm:ManagedInstance` on it in app-role.
6. Add a NAT Gateway in Public subnet B and the private route to it, then fly. The
   session now fails at edge-acl: the NAT Gateway sits behind it, and network ACLs are
   stateless.
7. Add HTTPS out and ephemeral ports in on edge-acl, then fly: a session.
8. Remove the bastion and every rule that mentions SSH.

The level's three objectives:

- every visitor is answered;
- the operator gets a shell through Session Manager;
- no security group lets SSH in.

★3: no bastion, and no rule anywhere mentions SSH.

**The engine** (`docs/ENGINE.md`, section 18):

- a public address on an instance (`publicAddress`), allowed only for a bastion host,
  which runs only SSH;
- the operator's flow (`shell`): SSH direct or through a bastion host as two
  connections, or, with Session Manager in the sky, a session. The session checks the
  managed-instance permission, then the agent's HTTPS connection out through the NAT
  Gateway, crossing its subnet's network ACL both ways;
- predicates: `session-opened`, `security-groups-closed-to`, `no-rule-names` and
  `all-of`;
- a security group on an instance with a public address counts as facing the internet
  for scoring.

**The game:**

- **The operator.** A kite kind `operator`, with a hat and a box kite. Its art entries
  are no longer marked planned, and it has every mood and state a Cloudling and a kite
  have.
- **Moving Cloudlings.** A kite's `moves` changes its address and place on the ground
  when the narrator reaches a step. Runs, rehearsals, the sky and the rule dropdowns
  all use `populationAt(level, narrationIndex)`, and a move makes the last flight out
  of date.
- **Placement.** The bastion host goes in a public subnet in the low band
  (`validSubnetsFor`, `bandOf`), and the tray names it.
- **The session's string** runs up to Session Manager, and a dashed thread runs from
  there down to the kite.
- **Removing rules.** Removing a security group rule that names a group nothing wears
  or names any more removes that group too, so a removed bastion's group cannot linger
  with no card to reach it.
- **Cards.** The role card offers `ssm:ManagedInstance` once Session Manager exists,
  and refuses it on anything else. Session Manager's card lists the managed instances
  and links to CloudTrail and "Session Manager in the real world".

**Content:**

- **Fact cards:** `session-manager`, and `session-manager-real-world` for the details
  the player does not configure:
  - the agent, preinstalled on Amazon Linux;
  - the instance profile with AmazonSSMManagedInstanceCore;
  - HTTPS 443 out to ssm, ssmmessages and ec2messages, with the replies through
    stateless network ACLs;
  - for interface endpoints: private DNS, the VPC's DNS hostnames and DNS resolution,
    and the endpoints' security group allowing 443 from the instances;
  - `ssm:StartSession` and the CLI plugin for the person starting a session.
- **Existing cards:** the CloudTrail card gained the `StartSession` point, and the
  bastion card's simplification is now true of Level 9.

**Two level tests, changed to fit a level that builds something and then takes it
away.** Neither is weaker; both still check what they checked before.

- **"has narrator steps the reference solution can complete"**
  - **Before,** every `scene` and `run-finished` predicate had to hold in the reference
    solution. Level 9's bastion steps and its twist cannot: the finished level has no
    bastion and the operator is no longer stopped.
  - **Now,** a level may name, per `run-finished` step, the scene a player has at that
    step (`narrationCheckpoints`). That step's predicate is flown against its
    checkpoint, with the Cloudlings where they stand at that step. Every other step,
    and every `scene` step (they can rewind), is still checked against the reference
    solution.
  - **Guarding the checkpoints.** They are validated as sound scenes, and
    `tests/game/noKeys.test.ts` plays the level through the store with the game's own
    edits. It checks that the narrator advances at every step, that the scene equals
    each checkpoint exactly, and that the finished scene equals the reference solution
    and earns three stars.
- **"aims every red kite at something the internet can actually reach"**
  - **Before,** it allowed only a load balancer or a bucket.
  - **Now,** it also allows an instance with a public address, looked up in the
    reference solution or the tray. It still rejects an instance with only a private
    address.

**Consequences.**

- **Tests.** 457 tests in 28 files pass offline:
  - `tests/engine/session-manager.test.ts` (new, with AWS doc citations): the probe,
    the bastion's two connections and their network ACLs, the address change, the
    managed-instance check and deny, the route and NAT Gateway network ACL cases, the
    new predicates, scoring, cost and validation;
  - `tests/game/noKeys.test.ts` (new): the playthrough, two stars while a rule mentions
    SSH, the role card's refusal, the layout, the move.
- **Played headlessly in the built game,** through every step to three stars:
  - the bastion and its group in Public subnet A;
  - the operator's /32 offered in the rule dropdowns;
  - the operator moving at the twist and being locked out;
  - the session's string through Session Manager;
  - the edge-acl failure on the NAT Gateway's side;
  - no console errors.
- **Simplifications:** rows 53–60 in `docs/SIMPLIFICATIONS.md`:
  - only a bastion has a public address, and it runs only SSH;
  - the SSH key is assumed;
  - placing Session Manager stands for choosing it, and the agent is installed;
  - `ssm:ManagedInstance` for AmazonSSMManagedInstanceCore;
  - the operator's own permission is assumed;
  - one stand-in endpoint address, and no interface endpoints;
  - the trace's order;
  - the scripted address change.
- **Threats:** a THREATS row for Level 9.
- **Still to check on Windows with npm:**
  - `npm test` and `npm run build`, expecting 457 tests in 28 files;
  - ESLint and Prettier.
