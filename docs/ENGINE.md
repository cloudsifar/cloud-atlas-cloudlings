# The engine, read top to bottom

The engine (`src/engine/`) is the game's model of AWS. It is pure TypeScript over plain
data: no DOM, no randomness, no dependencies. Everything the player sees a kite do is
decided here and reported as a **verdict plus a trace**.

This document walks the engine in reading order. Each rule section says what is
modelled, the AWS behaviour it reflects, where the code is, and which tests cover it.
It covers everything Levels 1–6 need: routing, security groups, network ACLs, IAM, S3,
the load balancer, cost, Auto Scaling and crowds, the timeline, RDS and Availability
Zone failure.

## 1. The data: `model.ts`

A `Scene` is the whole sky: one VPC, its subnets, route tables, network ACLs, security
groups and `resources` (the clouds). It is JSON-compatible, so the same shape is used in
level files, in undo history and in tests.

Things worth noticing in the types:

- Rules hold a `PortOption` (`'https'`, `'ssh'`, `'ephemeral'`…), never a number, so a
  rule can only say what the game teaches. `ports.ts` maps options to ranges.
- `SecurityGroupRule` has no `action` field: security groups cannot deny.
  `NetworkAclRule` has one.
- A NACL rule's peer is a `CidrPeer`; a security group rule's peer is a
  `SecurityGroupPeer`, which adds "another security group". The types make it
  impossible to write a NACL rule that names a security group.
- The VPC-local route is not stored in a `RouteTable`. It always exists and cannot be
  removed, so there is nothing to store.
- An Internet Gateway is "attached" by being present in `resources`.
- Positions are not stored. Where a cloud is drawn is derived from its subnet and band.

## 2. The contract: `trace.ts`

```ts
evaluateFlow(scene: Scene, flow: Flow): FlowResult
```

A `Flow` is one kite: where it starts, what it aims at, on which port, what it carries
(`payload`), who flies it (`intent`), and optionally a `backendCall` the application
makes when the request arrives (for example "store this upload in S3").

A `FlowResult` is an `outcome` (`delivered`, `blocked`, `dropped`, `breach`), a `trace`
of the way in, and a `responseTrace` of the way back. Each `TraceStep` records where it
happened (`at`), which kind of check it was (`check`), pass or fail, the rule that
decided (`ruleRef` for display, `matched` for code) and a plain-English `explanation`.
`leg` says which part of the journey the step belongs to: `request`,
`backend-request`, `backend-response` or `response`.

`failingStep(result)` returns the step that stopped the flow.

## 3. The evaluator: `flow.ts`

`evaluateFlow` chooses one of four journeys by looking at the source and destination,
then walks it. A journey is a list of small functions (`PendingCheck`), each returning
one `TraceStep`; `runChecks` runs them in order and stops at the first failure. Reading
a journey function top to bottom is reading the order AWS applies its controls.

**Journey 1: ground → load balancer → target.** In order:

1. Route: the kite must enter through the Internet Gateway into a public subnet.
2. Inbound NACL of the load balancer node's subnet.
3. The load balancer's security group (inbound).
4. The listener: is anything listening on that port?
5. Target selection among healthy targets.
6. The load balancer's security group (outbound, towards the target).
7. Outbound NACL of the load balancer's subnet, then inbound NACL of the target's subnet.
8. The target's security group (inbound).
9. Delivery at the target, then the backend call if the flow has one.
10. Response: security groups are noted as stateful and not evaluated; every NACL on the
    way back is evaluated again.

Covered by `tests/engine/flow.test.ts` ("request path order"), which pins the exact
sequence.

**Journey 2: instance → S3**, as a backend call or on its own: outbound security group,
outbound NACL, the route table's choice (gateway endpoint, NAT Gateway, or failure),
the NAT Gateway's subnet NACLs where relevant, then the S3 access decision, then the
reply through the NACLs.

**Journey 3: ground → bucket.** S3 is outside the VPC, so no VPC control takes part;
only the S3 access decision applies.

**Journey 4: ground → anything with a private address.** Always stopped at routing.

## 4. Routing: `routing.ts`

- **Modelled.** Each subnet has one route table. Every table has the implicit local
  route. The most specific matching route wins: a prefix-list route (gateway endpoint)
  beats `0.0.0.0/0`. A subnet is public if and only if its table sends `0.0.0.0/0` to an
  attached Internet Gateway. A NAT Gateway works only from a public subnet and only for
  connections that start inside the VPC. Gateway endpoints exist for S3 and DynamoDB.
- **AWS references.**
  [Route tables](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html),
  [route priority](https://docs.aws.amazon.com/vpc/latest/userguide/route-tables-priority.html),
  [internet gateways](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html),
  [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html),
  [gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html).
- **Code.** `resolveRoute` (specificity table `SPECIFICITY`), `isPublicSubnet`; the NAT
  and endpoint paths are in `instanceToBucketChecks` in `flow.ts`; "no way in from the
  ground" is `internetRouteStep` and `evaluateInternetToPrivateResource`.
- **Tests.** `tests/engine/routing.test.ts`.

## 5. Security groups: `securityGroups.ts`

- **Modelled.** Allow rules only. All rules of all groups on a resource are considered
  together, in no order. No inbound rules means no inbound traffic. A rule's source can
  be anywhere, a CIDR, or another security group ("any resource wearing that group").
  Stateful: the reply to an allowed connection is always allowed.
- **AWS references.**
  [Security groups](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html),
  [security group rules](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html).
- **Code.** `evaluateSecurityGroups`. Statefulness is expressed by _absence_: the
  response path in `flow.ts` never calls it, and instead records a passing step that
  says why.
- **Tests.** `tests/engine/security-groups.test.ts`.

## 6. Network ACLs: `networkAcls.ts`

- **Modelled.** Numbered rules, lowest first, first match wins, final `*` deny. Allow
  and deny. Inbound and outbound are separate lists and every packet is judged on its
  own (stateless), so replies need a rule covering ephemeral ports. One NACL per subnet.
  Traffic inside one subnet never meets a NACL.
- **AWS references.**
  [Network ACLs](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html),
  [NACL rules](https://docs.aws.amazon.com/vpc/latest/userguide/nacl-rules.html),
  [ephemeral ports](https://docs.aws.amazon.com/vpc/latest/userguide/nacl-ephemeral-ports.html).
- **Code.** `evaluateNetworkAcl`; the "crosses a boundary?" decision is
  `crossesBoundary` in `flow.ts`. The "default NACL" is simply a NACL whose two lists
  hold rule 100 allow-all; a "new custom NACL" is one with empty lists.
- **Tests.** `tests/engine/network-acls.test.ts`.

## 7. IAM: `iam.ts`

- **Modelled.** Implicit deny; an allow grants; an explicit deny overrides any allow.
  Statements name action families on one resource or `*`. Roles attach to instances;
  there are no access keys.
- **AWS references.**
  [Policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html),
  [IAM roles for EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html).
- **Code.** `evaluateIdentityPolicy` reports what the role's own policy says. Combining
  it with a resource policy is the resource's job (next section).
- **Tests.** `tests/engine/iam.test.ts`.

## 8. S3: `s3.ts`

- **Modelled.** A bucket is public only if Block Public Access is off _and_ its policy
  grants everyone. Block Public Access overrides a public policy. Within one account, an
  allow from the role's policy _or_ the bucket policy is enough; an explicit deny in
  either wins. A hostile kite reading a public bucket marked `sensitive` is a breach; a
  public bucket marked `public-content` is legitimate. Buckets are always encrypted at
  rest (SSE-S3).
- **AWS references.**
  [Blocking public access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html),
  [default encryption FAQ](https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-encryption-faq.html).
- **Code.** `evaluateBucketAccess`, `isBucketPublic`; the breach rule is in
  `evaluateInternetToBucket` in `flow.ts`.
- **Tests.** `tests/engine/s3.test.ts`.

## 9. Load balancer: in `flow.ts`

- **Modelled.** Internet-facing or internal; one node per subnet; one listener (HTTP 80
  or HTTPS 443); round robin over healthy targets in every enabled zone. A target is
  healthy if the instance is running _and_ the load balancer can reach it over the
  network. With no healthy targets the load balancer fails open and routes to all of
  them. With no registered targets it answers 503.
- **AWS references.**
  [Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html),
  [health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html).
- **Code.** `selectTarget`, `targetPassesHealthCheck`, `listenerStep`.
- **Tests.** `tests/engine/load-balancer.test.ts`.

## 10. Objectives, stars and validation

- `predicates.ts`: the vocabulary level files use for objectives, star criteria and
  narrator steps. `evaluatePredicate(scene, runs, predicate)` is one `switch`.
- `scoring.ts`: `scoreScene` returns least-privilege findings. It reads which rules the
  friendly kites relied on from `TraceStep.matched`, and reports editable rules that
  were not relied on or are wider than needed.
- `validate.ts`: `validateScene` reports broken references (malformed data) and
  misconfigurations (for example a NAT Gateway outside a public subnet).
- Tests: `tests/engine/scoring.test.ts`.

## 11. Cost: `cost.ts`

- **Modelled.** Each resource has a fixed running cost in coins. A NAT Gateway costs
  more than a small instance; an Internet Gateway and an IAM role cost nothing; a
  gateway endpoint is a route, not a resource, so it costs nothing either. Larger
  instances cost more. Coins are illustrative units, never prices.
- **AWS references.**
  [Gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html)
  (no additional charge),
  [NAT gateway pricing](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-pricing.html).
- **Code.** `coinsFor`, `costOfScene`. Two predicates use them and the routing rules:
  `cost-at-most` and `service-routed-through-gateway-endpoint` in `predicates.ts`.
- **Tests.** `tests/engine/cost.test.ts`.
- **Not modelled yet.** The brief's penalty for idle oversized instances needs the
  capacity model that arrives with Level 5.

## 12. Auto Scaling groups: `autoScaling.ts`

- **Modelled.** A group runs `desired` instances, held within `min` and `max`, spread
  evenly across its subnets. Desired capacity is where the group starts; a scaling
  policy moves it from there. Its instances are identical. A load balancer that
  targets the group targets its instances. Before any flow is evaluated the group is
  expanded into ordinary instances (`expandAutoScalingGroups`), so every other rule
  (security groups, network ACLs, health checks, IAM) applies to them unchanged.
  `validateScene` reports a group whose settings break minimum ≤ desired ≤ maximum,
  and the fleet card keeps them in that order as the player edits (`setGroupSettings`
  in `src/game/edits.ts`).
- **AWS references.**
  [Auto Scaling groups](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-groups.html),
  [scaling limits: desired capacity lies between minimum and maximum](https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-capacity-limits.html),
  [load balancers and Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/autoscaling-load-balancer.html).
- **Code.** `groupInstances`, `runningCount`, `expandAutoScalingGroups`; the group case
  in `validate.ts`.
- **Tests.** `tests/engine/auto-scaling.test.ts`, "group instances";
  `tests/game/edits.test.ts`.

## 13. Crowds, capacity and scaling: `crowd.ts`

- **Modelled.** `simulateCrowd(scene, crowd, timeline)` steps through one moment per
  tick (section 14). Each tick:
  1. instances that finished launching start serving;
  2. one representative kite is evaluated (`evaluateFlow`), to see whether the crowd
     gets through at all;
  3. capacity is the sum, over the load balancer's healthy targets, of the kites each
     size has room for (each Cloudling keeps one kite up, so the crowd's size is the
     load); kites beyond capacity time out (outcome `dropped`);
  4. CPU is the share of capacity in use, capped at 100%. A group that no load
     balancer targets serves nothing, so its own CPU is 0%;
  5. a target tracking policy decides on the group's CPU: above the target, launch
     enough instances to bring CPU back to it (in proportion), serving after
     `LAUNCH_TICKS`; below it for `SCALE_IN_TICKS` ticks in a row, remove enough to
     bring CPU back up to the target, never more than half the fleet at once and never
     below the minimum (ADR 0012).

  Each tick's record keeps two journeys for playback and the trace inspector: `served`
  (a kite that got a target, or, if the crowd cannot get through, what stopped it) and
  `timedOut` (a kite beyond capacity: the same checks up to the load balancer, then a
  failing `capacity` step at the load balancer, HTTP 504). It also keeps each group's
  own serving and launching instances, and what it started and removed (`fleets`), so
  the fleet can be drawn instance by instance; the room the targets have (`capacity`),
  which clouds they are (`serving`), and how many Availability Zones they span
  (`zonesInService`).

- **AWS references.**
  [Target tracking scaling policies](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html),
  [target tracking for Spot Fleet: "scales out proportionally to the metric as fast as it can, but scales in more gradually"](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-fleet-target-tracking.html),
  [dynamic scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scale-based-on-demand.html),
  [Application Load Balancer troubleshooting: HTTP 504 when a target does not answer before the idle timeout; add targets if they are too busy](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html).
- **Code.** `simulateCrowd`, `deliveredShare`; `healthyTargets` in `flow.ts`; the
  `capacity` check kind in `trace.ts`; predicates `crowd-delivered-at-least` (whole run,
  or `during: 'surge'`), `crowd-scaled-out-and-back-in`, `crowd-quiet-cpu-at-least` and
  `crowd-zones-at-least`.
- **Tests.** `tests/engine/auto-scaling.test.ts`: "capacity", "timed-out kites",
  "target tracking scaling", "what each tick records", "crowd predicates";
  `tests/engine/storm.test.ts`: "the crowd through the storm", "predicates for the
  storm".
- **Since Level 6** (ADR 0014), each tick also:
  - builds a live scene for that minute (`liveScene`): the group's instances by zone,
    those in a failed zone unhealthy, the databases' status and primary;
  - evaluates one journey per healthy target (round robin through the load balancer's
    nodes in zones that are up), and shares the crowd between targets by their room, so
    a target whose journey fails costs exactly its share (a target the database turns
    away, say);
  - after `HEALTH_CHECK_TICKS` (2) in a failed zone, terminates a group's lost instances
    and launches replacements in a zone that is up, if it has one;
  - fails a Multi-AZ database over in `FAILOVER_TICKS` (2); a single-AZ database in a
    failed zone is unavailable for the rest of the run.

  The record keeps the failed zones, each database's status and zones, each serving
  target's zone and outcome, each group's instances by zone and its replacements, and
  `stopped`: the first journey that reached a target but failed after it.

- **Not modelled yet.** Instance failure outside an AZ failure; the cost of
  instance-hours over the run; the load balancer's own capacity.

## 14. The timeline: `timeline.ts`

- **Modelled.** Nothing from AWS: this is the level's story. A level states its usual
  crowd (`kitesPerTick`, and how many `ticks` the run lasts) and its scripted events.
  `crowdTimeline(crowd, events)` turns them into one `CrowdMoment` per tick: how many
  kites fly, and whether the crowd is bigger than usual. Crowd waves (`crowd-arrives`,
  `crowd-leaves`) add or take away a group of Cloudlings from a given tick, never below
  the usual crowd (ADR 0012). A crowd surge climbs in a straight line from the usual
  crowd to its peak over `rampTicks`, holds for `holdTicks`, and falls back the same
  way; where surges overlap the bigger crowd wins, and a surge can lift a crowd that
  waves have grown. Why the timeline is
  separate from the simulation: `docs/adr/0005-crowds-and-the-event-timeline.md`.
  An `az-failure` event takes one Availability Zone down from its tick to the end of
  the run; every later moment lists it in `failedZones` (`failedZonesAt`). The scene
  itself is never edited: `simulateCrowd` applies the failure to each tick's live
  scene (section 13), so undo and the authored scene stay as they were.
- **Code.** `crowdTimeline`, `waveCrowdAt`, `surgeKitesAt`, `surgeWindow`,
  `failedZonesAt`.
- **Tests.** `tests/engine/timeline.test.ts`; level-file checks in
  `tests/levels/levels.test.ts`, "crowds and events".

## 15. RDS and Availability Zone failure: `flow.ts`, `crowd.ts`

- **Modelled.** An `rds-database` has a DB subnet group (`subnetIds`: private subnets
  in at least two Availability Zones, checked by `validateScene`), a primary subnet,
  `multiAz`, an engine (MySQL on 3306, PostgreSQL on 5432) and a status. A flow with a
  `backendCall` goes on from the instance that answered it to the database
  (`instanceToDatabaseChecks`): the instance's security group outbound, the VPC-local
  route, the network ACLs when the subnets differ, the database's security group
  inbound on the engine's port, then whether the database is available; the answer
  comes back through the network ACLs. A security group or network ACL that refuses
  gives `blocked`; a database failing over or down gives `dropped`. The endpoint
  follows a failover: after it, calls reach the new primary.

  In a failed zone (`scene.failedZones`, `subnetIsDown`): the load balancer has no
  node there; instances there are unhealthy; a NAT Gateway there carries nothing. With
  no healthy target left, the load balancer fails open (section 9), and a target in a
  failed zone never answers: its trace says the zone is down and the request timed
  out.

- **AWS references.**
  [Multi-AZ DB instance deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html),
  [failing over a Multi-AZ DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html),
  [DB subnet groups need two Availability Zones](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html),
  [a DB instance accessed by an EC2 instance in the same VPC](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.Scenarios.html),
  [Auto Scaling launches in an unaffected Availability Zone](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-add-az-console.html),
  [how Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html),
  [ALB fail-open](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html),
  [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html).
- **Code.** `instanceToDatabaseChecks`, `ENGINE_PORT` in `flow.ts`; `subnetIsDown` in
  `model.ts`; the RDS case in `validate.ts`; `liveScene` and the database states in
  `crowd.ts`; predicates `group-spans-zones`, `database-multi-az`,
  `security-group-allows-group`, `crowd-answered-at-end` and
  `crowd-failures-only-during-failover`.
- **Tests.** `tests/engine/storm.test.ts`.

## Not built yet

WAF, DynamoDB, SQS, SNS, Lambda, KMS, SSM, Route 53, and CloudWatch alarms other than a
scaling policy's. See `PROGRESS.md`.
