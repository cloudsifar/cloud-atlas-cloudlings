# The engine, read top to bottom

The engine (`src/engine/`) is the game's model of AWS. It is pure TypeScript over plain
data: no DOM, no randomness, no dependencies. Everything the player sees a kite do is
decided here and reported as a **verdict plus a trace**.

This document walks the engine in reading order. Each rule section says what is
modelled, the AWS behaviour it reflects, where the code is, and which tests cover it.
Currently it covers Milestone 1: routing, security groups, network ACLs, IAM, S3, and
the load balancer behaviour that Levels 1–3 need.

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
  evenly across its subnets. Its instances are identical. A load balancer that targets
  the group targets its instances. Before any flow is evaluated the group is expanded
  into ordinary instances (`expandAutoScalingGroups`), so every other rule (security
  groups, network ACLs, health checks, IAM) applies to them unchanged.
- **AWS references.**
  [Auto Scaling groups](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-groups.html),
  [load balancers and Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/autoscaling-load-balancer.html).
- **Code.** `groupInstances`, `runningCount`, `expandAutoScalingGroups`.
- **Tests.** `tests/engine/auto-scaling.test.ts`, "group instances".

## 13. Crowds, capacity and scaling: `crowd.ts`

- **Modelled.** `simulateCrowd(scene, crowd)` steps through ticks. Each tick: instances
  that finished launching start serving; one representative kite is evaluated to see
  whether requests get through at all; capacity is the sum over the load balancer's
  healthy targets; requests beyond capacity are `dropped`; CPU is the share of capacity
  in use. A target tracking policy then decides: above the target, launch enough
  instances to bring CPU back to it (in proportion); below it, remove one instance,
  but only if the rest would still be at or under the target. New instances serve
  after `LAUNCH_TICKS`.
- **AWS references.**
  [Target tracking scaling policies](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html),
  [dynamic scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scale-based-on-demand.html).
- **Code.** `simulateCrowd`; `healthyTargets` in `flow.ts`; predicates
  `crowd-delivered-at-least` and `crowd-scaled-out-and-back-in`.
- **Tests.** `tests/engine/auto-scaling.test.ts`, "capacity", "target tracking scaling",
  "crowd predicates".
- **Not modelled yet.** Replacing unhealthy instances; events during a crowd (AZ
  failure, instance failure); the cost of instance-hours over the run.

## Not built yet

WAF, Auto Scaling, capacity, RDS, DynamoDB, SQS, SNS, Lambda, KMS, SSM, Route 53,
CloudWatch, events (`applyEvent`) and cost. See `PROGRESS.md`.
