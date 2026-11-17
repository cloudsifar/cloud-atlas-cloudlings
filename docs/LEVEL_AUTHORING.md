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

## Fields

| Field                            | What goes in it                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `slug`, `title`, `concept` | Number, file-name slug, display title, one line on what the level teaches                                                                                                                             |
| `guidance`                       | `"full"`, `"hints"` or `"minimal"`                                                                                                                                                                    |
| `region`                         | `"us-east-1"`, `"eu-central-1"`, `"sa-east-1"` or `"ap-northeast-1"`: scenery only                                                                                                                    |
| `azs`                            | `1` or `2`                                                                                                                                                                                            |
| `narration`                      | Narrator steps, in order. May be `[]`                                                                                                                                                                 |
| `initialScene`                   | The scene the player starts from: a complete engine `Scene`                                                                                                                                           |
| `lockedIds`                      | Ids of anything the player may not change (resources, security groups, route tables, network ACLs)                                                                                                    |
| `palette`                        | Clouds the player may add, each written out in full with a fixed id                                                                                                                                   |
| `removableIds`                   | Optional. Ids of resources in the initial scene the player may remove (e.g. `["nat"]`). Palette clouds are always removable                                                                           |
| `gatewayEndpoints`               | Optional. `["s3"]` and/or `["dynamodb"]`: offers that gateway endpoint as a route on route cards. It is a route, not a palette cloud                                                                  |
| `population`                     | The Cloudlings and their kites                                                                                                                                                                        |
| `crowd`                          | Optional. The usual crowd: `{ loadBalancerId, ip, kitesPerTick, ticks }`. Simulated tick by tick, flown in the sky and shown on the weather station. The named kites in `population` are its regulars |
| `events`                         | Scripted events on the crowd's timeline. So far only crowd surges (see below); a surge needs a `crowd`. `[]` for levels without                                                                       |
| `objectives`                     | Goals, each a machine-checkable predicate with player-facing text                                                                                                                                     |
| `stars.wellArchitected`          | The third star: its text and the predicates that must all hold                                                                                                                                        |
| `hints`                          | One entry per objective, three tiers each                                                                                                                                                             |
| `factCards`                      | Ids from `content/fact-cards.json`, shown on the results card                                                                                                                                         |
| `referenceSolution`              | The intended finished scene. Never shown to players; the tests use it                                                                                                                                 |

Every level is self-contained: it starts from its own `initialScene` and never depends
on another level. To build on an earlier level, copy that level's `referenceSolution`
in as the new `initialScene` and change what the story needs.

## Scenes

`initialScene` and `referenceSolution` are engine `Scene` values (`src/engine/model.ts`).
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

## Crowds and events

A crowd level states its usual crowd and its events; the engine builds one moment per
tick from them (`src/engine/timeline.ts`). Level 5:

```json
"crowd": { "loadBalancerId": "alb", "ip": "203.0.113.50", "kitesPerTick": 4, "ticks": 30 },
"events": [
  { "kind": "crowd-surge", "atTick": 3, "rampTicks": 6, "holdTicks": 6, "peakKitesPerTick": 40 }
]
```

The surge climbs in a straight line from 4 to 40 over 6 ticks, holds for 6, and falls
over 6. The validator checks that the load balancer exists in the reference solution,
the address is a documentation address, the peak is above the usual crowd, and the
surge is over before the run ends. Leave quiet ticks after the surge if a star depends
on capacity scaling back in.

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

Select kites with `{ "intent": "legitimate" }`, `{ "intent": "hostile" }` or
`{ "flowIds": ["green-1"] }`. Values for `by`: `route`, `nacl`, `security-group`,
`listener`, `target-selection`, `iam`, `block-public-access`, `bucket-policy`.

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
  "text": "First, a gate. Drag the Internet Gateway from the tray into the sky.",
  "highlight": "palette:igw",
  "advanceWhen": {
    "kind": "scene",
    "predicate": { "kind": "resource-exists", "resourceId": "igw" }
  }
}
```

`advanceWhen` says what moves the narrator on:

| Trigger                                     | Moves on when                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `{ "kind": "acknowledged" }`                | The player presses Next                                                                                                    |
| `{ "kind": "scene", "predicate": … }`       | The scene satisfies the predicate. If it is already true, the step is skipped, so players who work ahead are not held back |
| `{ "kind": "card-opened", "subjectId": … }` | The player opens that config card                                                                                          |
| `{ "kind": "run-finished" }`                | The kites have flown, whatever happened                                                                                    |
| `{ "kind": "level-complete" }`              | The kites have flown and every objective was met. Use this before a step that congratulates                                |

`highlight` is optional: `palette:<id>`, `resource:<id>`, `subnet:<id>` or `button:fly`.

## Hints

One entry per objective: a `nudge`, a `pointer` (text plus an optional `highlight`),
and a `nearAnswer`. They are revealed one at a time and carry no penalty.

## What the tests check for every level

- the file validates;
- the initial scene fails at least one objective;
- the reference solution meets every objective and earns all three stars;
- the narrator's steps can all be completed by the reference solution.

## Player-facing text elsewhere

- `content/explanations.json`: the box shown when a cloud is placed, one entry per service.
- `content/fact-cards.json`: fact cards, including each service's disclosed
  simplifications and its Cloud Atlas page reference (`TODO(Simon)`).
