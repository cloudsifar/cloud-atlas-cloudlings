# Writing a level

A level is one JSON file in `levels/`. It contains no code. The type that describes it
is `Level` in [`src/levels/schema.ts`](../src/levels/schema.ts); that file is the
reference, and this guide is the tour.

## The quick way

1. Copy the level closest to what you want, e.g. `levels/03-the-rain-store.json`, to
   `levels/04-skyway.json`. Change `id`, `slug`, `title`, `concept`.
2. Import it in [`src/levels/loader.ts`](../src/levels/loader.ts) and add it to the
   `LEVELS` list. Ids must run from 1 with no gaps.
3. Run the tests (`npm test`). The level tests pick the new file up automatically and
   tell you, by field name, what is wrong.

## Pacing: a level is not a race

Simon's lesson from Level 5 (25 November 2026), for every level from here on: **leave
enough time between events for the player to see each one, work out what it meant, and
read the cards.** A level could be completed in ten seconds. It should instead invite
the player to linger: let the run play out, watch the cause and its effect, and open
the clouds' cards before and after.

In practice:

- **One thing at a time.** Space events so each has finished, and its effect is visible,
  before the next begins. In Level 5, groups arrive four minutes (5 s) apart, so the
  dial can climb, the bell ring, instances launch and the dial fall back in between.
- **Show cause, then effect.** The thing that happens (a group arrives, an Availability
  Zone fails) comes first; its consequences (CPU rises, the alarm rings, the fleet grows)
  follow visibly, a moment later, in the order AWS does them.
- **Slow is fine.** A minute lasts 1.25 s on screen (`TICK_DURATION`), and a crowd run
  about 30 s. Minutes in which a storm's story happens (a zone fails, a database fails
  over, a group replaces what it lost) play three times slower, automatically
  (`heldMinutes` in `src/game/crowdPlayback.ts`, ADR 0014); Level 6's storm takes 15 s. Start with a calm stretch, so the player sees the normal working state
  before anything changes, and end with one, so the final state can be read.
- **Make every change readable without the animation.** CloudWatch's log in the side
  panel, the captions on clouds and the trace say in words what the sky showed, for a
  player who missed it or wants to check.
- **Invite reading.** The first narrator step can say the cards are worth opening before
  the first run. The results card waits until the run has played out (ADR 0009).
- **Do not make the player wait for nothing.** Once a crowd run has settled with nothing
  answered and nothing left to change (a storm took everything down), it ends two
  minutes later, on its own, and the narrator moves on (`playedTicks`, ADR 0015). Simon,
  25 November 2026: "after the kites drop to the ground the simulation is over anyway".
- **Fit the narrator's box.** It shows three lines of text and the step count, about 340
  characters; a longer step scrolls, and a player may never see its end. A last step
  that tells the player how to earn a missing star must fit.

## Fields

| Field                            | What goes in it                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `slug`, `title`, `concept` | Number, file-name slug, display title, one line on what the level teaches                                                                                                                                 |
| `guidance`                       | `"full"`, `"hints"` or `"minimal"`                                                                                                                                                                        |
| `region`                         | `"us-east-1"`, `"eu-central-1"`, `"sa-east-1"` or `"ap-northeast-1"`: scenery only                                                                                                                        |
| `azs`                            | `1` or `2`                                                                                                                                                                                                |
| `narration`                      | Narrator steps, in order. May be `[]`                                                                                                                                                                     |
| `initialScene`                   | The scene the player starts from: a complete engine `Scene`                                                                                                                                               |
| `lockedIds`                      | Ids of anything the player may not change (resources, security groups, route tables, network ACLs)                                                                                                        |
| `palette`                        | Clouds the player may add, each written out in full with a fixed id                                                                                                                                       |
| `removableIds`                   | Optional. Ids of resources in the initial scene the player may remove (e.g. `["nat"]`). Palette clouds are always removable                                                                               |
| `removalWarnings`                | Optional. A warning shown before the player removes a cloud, by resource id, e.g. `{ "alb": "If you remove the load balancer…" }`. The player chooses Keep it or Remove anyway. Only for removable clouds |
| `gatewayEndpoints`               | Optional. `["s3"]` and/or `["dynamodb"]`: offers that gateway endpoint as a route on route cards. It is a route, not a palette cloud                                                                      |
| `population`                     | The Cloudlings and their kites                                                                                                                                                                            |
| `crowd`                          | Optional. The usual crowd: `{ loadBalancerId, ip, kitesPerTick, ticks }`. Simulated tick by tick, flown in the sky and shown on the weather station. The named kites in `population` are its regulars     |
| `events`                         | Scripted events on the crowd's timeline: crowd waves and crowd surges (see below); both need a `crowd`. `[]` for levels without                                                                           |
| `objectives`                     | Goals, each a machine-checkable predicate with player-facing text                                                                                                                                         |
| `stars.wellArchitected`          | The third star: its text and the predicates that must all hold                                                                                                                                            |
| `hints`                          | One entry per objective, three tiers each                                                                                                                                                                 |
| `factCards`                      | Ids from `content/fact-cards.json`, shown on the results card                                                                                                                                             |
| `referenceSolution`              | The intended finished scene. Never shown to players; the tests use it                                                                                                                                     |

Every level is self-contained: it starts from its own `initialScene` and never depends
on another level. To build on an earlier level, copy that level's `referenceSolution`
in as the new `initialScene` and change what the story needs.

## Scenes

`initialScene` and `referenceSolution` are engine `Scene` values (`src/engine/model.ts`).
An RDS database is a resource like any other:

```json
{
  "kind": "rds-database",
  "id": "db",
  "name": "orders database",
  "engine": "mysql",
  "subnetIds": ["private-a", "private-b"],
  "securityGroupIds": ["sg-db"],
  "primarySubnetId": "private-a",
  "multiAz": false,
  "status": "available"
}
```

Its subnets are its DB subnet group: private, in both zones, with the primary among
them. Its security group should allow the engine's port (`mysql` or `postgresql`).

An AWS WAF web ACL (Level 7) protects one load balancer:

```json
{
  "kind": "waf-web-acl",
  "id": "shop-waf",
  "name": "shop-web-acl",
  "loadBalancerId": null,
  "defaultAction": "allow",
  "rules": []
}
```

In a palette entry, leave `loadBalancerId` null: placing the web ACL associates it with
the scene's load balancer, and removing it clears the association. Rules are
`{ "kind": "core-rule-set" }`, `{ "kind": "rate-based", "limit": 100 }` (a whole number,
at least 10, per five minutes) and `{ "kind": "ip-set", "cidrs": ["198.51.100.0/24"] }`,
each kind at most once.

Network ACLs: mark the VPC's default one `"isDefault": true` (every level has one). A
second, custom ACL that the player associates and edits starts with whatever rules the
level gives it; rule numbers run from 1 to 32766. The least-privilege star judges the
allow rules of custom ACLs the player can edit (every allow rule must be one some kite
relied on, and none may open all traffic); it never judges the default ACL.
The simplest way to write `referenceSolution` is to copy `initialScene` and make the
changes the player is meant to make. Two rules the validator enforces:

- the solution may only add resources that the `palette` offers, with the same ids;
- the solution may not change anything listed in `lockedIds`.

Ids matter because kites, objectives and narration refer to things by id, including
things that do not exist until the player places them. That is why a palette entry
carries a complete resource with a fixed id (for example the bucket `photos`).

## Kites

```json
{
  "id": "green-1",
  "kind": "friendly",
  "groundPosition": 0,
  "ip": "203.0.113.10",
  "destinationId": "alb",
  "port": 443,
  "payload": "clean",
  "label": "uploads a photo",
  "says": "I want to upload a photo!",
  "backendCall": { "destinationId": "photos", "action": "s3:Write" }
}
```

- `groundPosition` is 0 (left) to 6 (right).
- `ip` must come from the documentation ranges: `192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`.
- `destinationId` is what the kite aims at: a load balancer, an instance or a bucket.
- `backendCall` is what the application does when the request arrives. The kite only
  counts as delivered if that call succeeds too.
- A kite that calls a service directly (a hostile kite reading a bucket) uses `action`
  instead, e.g. `"action": "s3:Read"`.
- A hostile kite must aim at something the internet can reach: the load balancer or
  S3, never an EC2 instance in a private subnet. Add a row to `docs/THREATS.md` saying
  what it tries and what stops it; a level test checks the target.
- A `backendCall` to an RDS database (`{ "destinationId": "db" }`, no `action`) is a
  query from the instance that answered the kite: it needs the database's security
  group to allow the engine's port from that instance, and the database to be
  available (Level 6).
- `rate` (optional) is how many requests the Cloudling sends in five minutes. Leave it
  out for an ordinary visitor (counted as 20). A flood sets it high (Level 7: 3000);
  above ten times the ordinary rate it is drawn as a flock of kites. Only a WAF
  rate-based rule reads it.
- `label` names what the kite does, for the trace inspector. `says` is what the
  Cloudling says in its speech bubble when clicked, in its own voice: "I want to visit
  the website!", or for a hostile one, what it is after.

## Crowds and events

A crowd level states its usual crowd and its events; the engine builds one moment per
tick from them (`src/engine/timeline.ts`). A tick is one CloudWatch minute, 1.25 s on
screen. Each Cloudling keeps one kite up while it stays, so the crowd's size is the
load. Level 5 (ADR 0012):

```json
"crowd": { "loadBalancerId": "alb", "ip": "203.0.113.50", "kitesPerTick": 4, "ticks": 26 },
"events": [
  { "kind": "crowd-arrives", "atTick": 2, "cloudlings": 5 },
  { "kind": "crowd-arrives", "atTick": 6, "cloudlings": 10 },
  { "kind": "crowd-arrives", "atTick": 10, "cloudlings": 21 },
  { "kind": "crowd-leaves", "atTick": 14, "cloudlings": 21 },
  { "kind": "crowd-leaves", "atTick": 18, "cloudlings": 10 },
  { "kind": "crowd-leaves", "atTick": 22, "cloudlings": 5 }
]
```

`kitesPerTick` is the usual crowd: the Cloudlings there all day. Waves add a group from
their tick on and take it away when it leaves. Four ticks apart is 5 s on screen, which
leaves time to see each group arrive, the alarm ring, new instances launch and the dial
fall back. Newcomers walk on over the two ticks before their wave, so leave at least two
ticks before the first. The validator checks that the load balancer exists in the
reference solution and that the address is a documentation address. It also checks that
every wave is inside the run, that nobody leaves who has not arrived, and that the crowd
never exceeds `MAX_CROWD` (40), the places on the ground.

A `crowd-surge` (`atTick`, `rampTicks`, `holdTicks`, `peakKitesPerTick`) is another
kind of event: a straight-line climb to a peak, a hold, and a fall. It must be over
before the run ends, and its peak must be above the usual crowd.

An `az-failure` (`atTick`, `zone`) takes an Availability Zone down from its tick to the
end of the run (ADR 0014). It must fall inside the run, after the first tick and before
the last, and the level must have both zones. Leave a calm stretch first: in Level 6 the
storm comes at minute 8, 10 s in, so the player sees the application working before it
breaks.

```json
"crowd": { "loadBalancerId": "alb", "ip": "203.0.113.50", "kitesPerTick": 8, "ticks": 26,
           "backendCall": { "destinationId": "db" } },
"events": [{ "kind": "az-failure", "atTick": 8, "zone": "a" }]
```

`crowd.backendCall` is what the application does for each crowd kite, as on a named
kite: here, query the orders database. Each healthy target's journey decides what
happens to its share of the crowd.

A crowd of at most twice the named Cloudlings stands in one spaced-out row, the
newcomers between the regulars; a bigger one fills two rows from the middle out.

To tune a crowd level, simulate a few builds before choosing numbers: the reference
solution should pass comfortably, the initial scene should fail clearly, and an
under-built answer (too small a maximum, too high a CPU target) should fall short.

## Objectives and predicates

```json
{
  "id": "red-blocked",
  "text": "The red kite is stopped by Block Public Access",
  "predicate": {
    "kind": "flows-stopped",
    "flows": { "intent": "hostile" },
    "by": "block-public-access"
  }
}
```

The predicates available today (`src/engine/predicates.ts`):

| Predicate                                 | True when                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `flows-delivered`                         | Every selected kite was delivered, response included                                                                                        |
| `flows-stopped` (optional `by`)           | Every selected kite was stopped; with `by`, stopped by that control                                                                         |
| `resource-exists`                         | A resource with that id is in the scene                                                                                                     |
| `route-present`                           | The route table has that destination pointing at that kind of target                                                                        |
| `security-group-allows`                   | The group has exactly that inbound rule                                                                                                     |
| `listener-is`                             | The load balancer's listener is `http` or `https`                                                                                           |
| `targets-registered`                      | The load balancer has at least that many targets                                                                                            |
| `targets-in-both-azs`                     | Its targets cover both Availability Zones                                                                                                   |
| `targets-accept-only-load-balancer`       | Every inbound rule on every target names the load balancer's security group and nothing wider                                               |
| `role-attached`                           | Each listed instance has a role                                                                                                             |
| `role-allows`                             | The role allows that action on that resource                                                                                                |
| `bucket-locked-down`                      | Block Public Access is on and the bucket policy grants nothing to everyone                                                                  |
| `service-routed-through-gateway-endpoint` | Every subnet holding an instance sends that service's traffic to a gateway endpoint                                                         |
| `cost-at-most`                            | The running cost is at most that many coins. Using it anywhere in a level makes the side panel show the running cost                        |
| `crowd-delivered-at-least`                | At least `percent` of the crowd's kites were delivered: over the whole run, or with `"during": "surge"` only on surge ticks (needs `crowd`) |
| `crowd-scaled-out-and-back-in`            | More targets were in service at the busiest tick than at the end (needs `crowd`)                                                            |
| `crowd-quiet-cpu-at-least`                | Before the crowd first grows, CPU is at least `percent`: the fleet is not oversized for the usual crowd (needs a crowd that grows later)    |
| `crowd-zones-at-least`                    | On every tick the healthy targets span at least `zones` Availability Zones (needs `crowd`)                                                  |
| `targets-include`                         | The load balancer sends requests to that cloud (an instance, or a whole Auto Scaling group)                                                 |
| `group-can-scale`                         | The Auto Scaling group has a scaling policy and a maximum above its minimum                                                                 |
| `none-of`                                 | None of the listed `predicates` holds, e.g. neither fixed instance is a target any more                                                     |
| `group-spans-zones`                       | The Auto Scaling group `groupId` has subnets in every one of `zones`                                                                        |
| `database-multi-az`                       | The RDS database `databaseId` is Multi-AZ                                                                                                   |
| `security-group-allows-group`             | The group `securityGroupId` allows `ports` inbound from the group `fromSecurityGroupId` (security group chaining)                           |
| `crowd-answered-at-end`                   | Every crowd kite in the last tick was answered (needs `crowd`)                                                                              |
| `crowd-failures-only-during-failover`     | Every tick was fully answered, or a database was failing over during it: static stability (needs `crowd` and a database)                    |
| `network-acl-on-subnets`                  | Every one of `subnetIds` is associated with the network ACL `networkAclId`                                                                  |
| `network-acl-allows`                      | The network ACL has an allow rule in `direction` for `ports` from (or to) `peer`                                                            |
| `network-acl-rules-spaced`                | The network ACL's rule numbers, in each direction, start at `gap` or above and are at least `gap` apart (AWS: leave room, 100, 110, 120)    |
| `web-acl-protects`                        | A web ACL is associated with the load balancer `loadBalancerId` and has every rule kind in `rules`                                          |

Select kites with `{ "intent": "legitimate" }`, `{ "intent": "hostile" }` or
`{ "flowIds": ["green-1"] }`. Values for `by`: `route`, `nacl`, `security-group`,
`listener`, `waf`, `target-selection`, `iam`, `block-public-access`, `bucket-policy`.

**Order matters.** When the kites land, the objectives tick one at a time, a second
apart, in the order they are listed here (ADR 0011). List them in the order the player
sees them happen, and put the level's summary objective (the lesson in one line) last,
so it ticks last.

If a level needs a statement none of these can make, add a predicate to
`predicates.ts` with a test; do not put logic in the level file.

## Stars

- ★ **It works**: every objective met.
- ★ **Least privilege**: computed by the engine for every level (`src/engine/scoring.ts`).
  There is nothing to write in the level file.
- ★ **Well architected**: `stars.wellArchitected`, a line of text and a list of predicates.

## Narration

```json
{
  "id": "place-igw",
  "text": "First, a gate. Drag the Internet Gateway down to the bottom edge of the VPC, in the band marked Low – public. When that part of the sky lights up, let go.",
  "highlight": "palette:igw",
  "advanceWhen": {
    "kind": "scene",
    "predicate": { "kind": "resource-exists", "resourceId": "igw" }
  }
}
```

`advanceWhen` says what moves the narrator on:

| Trigger                                      | Moves on when                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ "kind": "acknowledged" }`                 | The player presses Next                                                                                                                                                  |
| `{ "kind": "scene", "predicate": … }`        | The scene satisfies the predicate. If it is already true, the step is skipped, so players who work ahead are not held back                                               |
| `{ "kind": "card-opened", "subjectId": … }`  | The player opens that config card                                                                                                                                        |
| `{ "kind": "run-finished" }`                 | The kites have flown, whatever happened                                                                                                                                  |
| `{ "kind": "run-finished", "predicate": … }` | The kites have flown with the scene as it is now, and that scene satisfies the predicate: "make this change, then fly". A run from before the latest edit does not count |
| `{ "kind": "level-complete" }`               | The kites have flown and every objective was met. Use this before a step that congratulates                                                                              |

A step that waits for a flight shows no Next button, so its text must tell the player to
fly (a level test checks for the word). With a predicate, the Fly button also points
itself out once the sky would satisfy it.

`highlight` is optional: `palette:<id>`, `resource:<id>`, `subnet:<id>` or `button:fly`,
or a list of them to point at several things at once (both EC2 instances that share a
security group).

`pulse` is optional: card sections whose headings pulse while the step is current, to
say "over here" (ADR 0008), e.g. `"pulse": ["security-group:sg-alb"]`. The sections are
`security-group:<id>`, `route-table:<id>`, `listener:<load balancer id>`,
`targets:<load balancer id>`, `role-statements:<role id>`, `role-wearers:<role id>`,
`instance-role:<instance id>`, `group-scaling:<group id>`, `group-subnets:<group id>`,
`group-size:<group id>` (the minimum), `database-multi-az:<database id>`,
`network-acl:<network ACL id>` (its heading on a subnet's card),
`subnet-network-acl:<subnet id>` (the subnet's "This subnet uses" choice) and
`web-acl-rules:<web ACL id>`. In Levels 1–3 every step that asks for a setting to
change must have one; the level tests check it.

**Linking a phrase to a fact card.** A step's text may contain
`[phrase](card:fact-card-id)`, e.g. `something like a [bastion host](card:concept-bastion-host)`.
The narrator shows the phrase as an underlined link that opens the card (ADR 0011). The
validator rejects a link to a card that is not in `content/fact-cards.json`. Nothing
else in a step is markup.

**Scene steps can come back.** If the player undoes what a completed scene step asked
for (removes the load balancer, takes away the route), the narrator returns to the
earliest scene step that no longer holds, and the steps after it follow again as the
player rebuilds. Steps that were acknowledged or saw a run stay done. So write scene
steps cumulatively: each one should still hold in the reference solution. The level
tests check exactly that, so a step that would bounce back fails them.

**Say where to drop a cloud.** A cloud is placed only if it is let go over a zone where
it belongs, which lights up under the pointer; anywhere else it goes back to the tray
(ADR 0007). In guided levels, the narration names the band or the spot.

## Hints

One entry per objective: a `nudge`, a `pointer` (text plus an optional `highlight`),
and a `nearAnswer`. They are revealed one at a time and carry no penalty.

## What the tests check for every level

- the file validates;
- the initial scene fails at least one objective;
- the reference solution meets every objective and earns all three stars;
- the narrator's steps can all be completed by the reference solution.

## Zone and subnet letters

Zone and subnet letters are always shown in bold, everywhere: in narration, hints, cards,
the weather station, traces and the sky's captions (Simon, 25 November 2026). Write them
as plain text; the game finds and bolds them (`letterSegments` in `src/levels/markup.ts`):

- Availability Zones are lower case, as in eu-central-1a: "AZ a", "Availability Zone b",
  "AZs a and b". A level test rejects "AZ A" in any level or fact card.
- Subnets are upper case: "Private subnet A", "Public subnet B", "subnets A and B".

Only those phrases count, so the article in "each zone a cloud of its own" stays as it
is. Text inside a dropdown option cannot be bold and is left plain.

## Player-facing text elsewhere

- `content/explanations.json`: the box shown when a cloud is placed, one entry per service.
- `content/fact-cards.json`: fact cards, including each service's disclosed
  simplifications and its Cloud Atlas page reference (`TODO(Simon)`).

## Pictures

Every visual the game draws looks itself up in `assets/manifest.json` by id (ADR 0016).
Until a picture exists, the placeholder drawing stands in. When a level brings in a new
kind of cloud, construct, effect or panel:

1. Add a manifest entry for it, with `"status": "planned"` until it is drawn, and its
   size, anchor, frames and points.
2. Ask for it in the code by that id (`drawArt`, `drawArtAt`, `drawArtBetween`, or an
   `--art-…` custom property for interface pictures), keeping a placeholder.
3. Run `npm run assets:list` to regenerate `docs/ASSET_LIST.md`.

`tests/game/art.test.ts` fails if a drawn id has no entry, if an entry is never asked
for, or if the asset list is out of date.
