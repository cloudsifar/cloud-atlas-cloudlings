# 0014 — Level 6, Storm Front: RDS, Availability Zone failure and a storm worth watching

**Context.** The brief's Level 6 teaches resilience at Cloud Practitioner level: an
application survives the loss of an Availability Zone (AZ) if nothing it needs lives
in only one zone. That needs three things the engine did not have:

- a database;
- an AZ failure that happens part-way through a run;
- an Auto Scaling group that replaces what it loses.

It also follows Simon's lesson from Level 5 (25 November 2026): "allow enough time
between events so that the user can process what is happening and understand it. The
level is not a race."

**Decision.**

The level (`levels/06-storm-front.json`):

- **The starting sky.** Eight Cloudlings look up their orders through the load
  balancer. The web fleet (an Auto Scaling group, two small instances) runs only in
  Private subnet A. The orders database (RDS for MySQL) is single-AZ, with its primary
  in AZ a. At minute 8, AZ a fails, and the application goes down with it.
- **Three fixes, one narrator step each.**
  1. Spread the fleet over both private subnets.
  2. Make the database Multi-AZ.
  3. Chain the database's security group to `ec2-app-sg`.
- **The third fix is a trap built into the level.** The database's security group
  starts by allowing MySQL from 10.0.11.0/24, Private subnet A's range. Spreading the
  fleet therefore turns AZ b's instances away even before the storm. This is the
  lesson of rule chaining: an address range belongs to one subnet in one zone, and a
  security group follows the instances wherever they run.
- **Objectives.** At least 90% of kites answered through the storm, and every kite
  answered at the end.
- **Third star: static stability.** No kite fails except while the database fails
  over. That needs AZ b to carry the whole crowd on its own: minimum 4, two instances
  in each zone. The guided fix (minimum 2) loses a minute while the replacements
  launch.

The engine (`src/engine/`):

- **RDS** (`model.ts`, `validate.ts`, `flow.ts`).
  - The database's attributes:
    - a DB subnet group, which must cover at least two AZs and contain private
      subnets only;
    - a primary subnet;
    - `multiAz`;
    - a status: `available`, `failing-over` or `unavailable`.
  - An application call to it (`backendCall` on a flow) is checked in this order:
    1. the instance's security group outbound;
    2. the local route;
    3. the network ACLs (only when the subnets differ);
    4. the database's security group inbound, on the engine's port (MySQL 3306,
       PostgreSQL 5432);
    5. whether the database is available.
  - The response comes back through the network ACLs. A database that is failing over
    or down gives outcome `dropped`. One whose security group refuses the caller gives
    `blocked`.
- **AZ failure** (`timeline.ts`, `crowd.ts`).
  - An `az-failure` event marks the zone as down from its tick to the end of the run
    (`failedZonesAt`).
  - In each tick's live scene:
    - instances in the zone are unhealthy;
    - the load balancer's node there is out of service, so kites reach the other node;
    - a NAT Gateway there carries nothing.
  - A Multi-AZ database fails over to its standby in `FAILOVER_TICKS` (2). A
    single-AZ one is down for the rest of the run.
  - A group's health checks notice after `HEALTH_CHECK_TICKS` (2). It then terminates
    the lost instances and launches replacements in a zone that is up, which serve
    `LAUNCH_TICKS` (2) later. A group with no subnet elsewhere has nowhere to launch.
- **With nothing healthy, the load balancer fails open, as the ALB documentation
  says.** It tries a target anyway. A target in a failed zone never answers, so its
  trace says that the instance's zone is down and the request timed out.
- **Per-target pooling.** The crowd is shared between the healthy targets by room, and
  each target's journey decides what happens to its share. So a target that the
  database turns away costs exactly its share. Before this, one representative journey
  decided the fate of the whole crowd.
- **The tick record has new fields:**
  - `failedZones`;
  - `databases` (status, primary zone, standby zone);
  - `serving`, now with a zone and an outcome per entry;
  - `fleets[].zones` (serving, launching and failed instances by zone);
  - `fleets[].replaced`;
  - `stopped` (the first journey that reached a target but failed after it).

  Level 5's record tests were updated to the richer shape and still assert the same
  facts.

- **Five new predicates:**
  - `group-spans-zones`;
  - `database-multi-az`;
  - `security-group-allows-group`;
  - `crowd-answered-at-end`;
  - `crowd-failures-only-during-failover`.

The sky (`src/game/`):

- **The storm.**
  - Lightning strikes cloud to ground over the failed zone, with a flash and thunder.
  - A grey wash then lies over that zone's column for the rest of the run.
  - "⚡ Availability Zone a is down" is written above the VPC, over the column, so it
    covers nothing it describes.
- **The fleet** is drawn per zone. Lost instances are grey and droop; terminated ones
  fade; replacements are dashed until they serve.
- **The database** is a flat altostratus. A Multi-AZ standby sits faintly in the other
  zone, joined to the primary by a wisp bridge (the grammar's "connected"). During a
  failover, lightning arcs from cloud to cloud and the standby wakes, from faint to
  solid. A copy lost with its zone stays grey. The primary and standby sit either side
  of the zone divider. Their captions go on the outer side, away from the bridge, and
  the fleet sits above them with its caption.
- **Dots** go from the load balancer to each zone's half of the fleet, then on to the
  database, coloured by outcome: blue answered, red turned away, grey no answer.
- **Labels for kites that fail.**
  - A database that cannot answer is labelled beneath it ("✕ no answer while it fails
    over"). The kites still go all the way up to the load balancer and fall.
  - A target that never answers is labelled "✕ nothing answers here".
- **Eventful minutes play slower** (`heldMinutes`, `crowdClock`). Each of these lasts
  `HELD_MINUTE_DURATION` (3.75 s) instead of 1.25 s:
  - a zone fails;
  - a database changes state or is failing over;
  - during a storm, a group launches replacements or its serving instances change.

  On the reference solution those are minutes 8–11, so the storm's story takes 15 s,
  like a replay in slow motion. The whole run takes about 44 s. A day with no storm and
  no database holds nothing, so Level 5's pace is unchanged (tested).

- **A small, steady crowd stands in one spaced-out row.** It is at most twice the
  regulars, so the newcomers take the gaps between the regulars, then the ends. A big
  crowd (Level 5) keeps its places (tested).

The panels (`src/ui/`):

- **The fleet card** has subnet checkboxes ("and so Availability Zones"), with a note
  on what one zone means.
- **The database card** shows:
  - the engine and port;
  - the DB subnet group;
  - where the primary and standby run;
  - the Multi-AZ checkbox and what a failover does;
  - its security group's rules.
- **The weather station** says after a run:
  - when the zone failed;
  - the healthy instances over the run;
  - whether the group replaced what it lost, or had nowhere to launch;
  - what the database did.

  Its headline is "Every kite answered, except while the database failed over" when
  that is all that went wrong. "Follow a kite with no healthy instance to answer it"
  opens a storm minute's journey.

- **A timed-out kite's trace** now says "Timed out at …" and "The visitor got no
  answer", instead of "turned away", which is for kites that were blocked.

**Consequences.**

- **Tests.**
  - `tests/engine/storm.test.ts`, citing AWS docs:
    - RDS flows;
    - placement rules;
    - AZ failure;
    - fail-open in a failed zone;
    - the crowd through the storm;
    - the storm predicates.
  - `tests/game/stormPlayback.test.ts`: the pace, the ground, the sky in the storm and
    the CloudWatch log.
  - The suite has 308 tests on the offline runner.
- **New simplifications**, rows 30–37 in `docs/SIMPLIFICATIONS.md`:
  - a fixed two-minute failover;
  - no new standby after a failover;
  - credentials left out;
  - one database per application, with its security group checked before its
    availability;
  - zones that fail all at once and never recover;
  - health checks that notice after two minutes;
  - the load balancer leaving a failed zone at once;
  - the per-target pool.

  Slow-motion minutes are not among them: they change how long a minute lasts on
  screen, not what happens in it.

- **Still to come.**
  - The fact cards' `atlasPage` links (`TODO(Simon)`).
  - The sounds `thunder` and `failover` are synthesised placeholders.
  - A replay speed control would now help on both crowd levels.
