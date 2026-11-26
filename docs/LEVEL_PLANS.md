# Level plans: the regional stories, and Levels 9–12

Agreed with Simon on 26 November 2026, before Level 9 was built. This file is the
starting point for the remaining levels. ADR 0019 records what was changed in
Levels 1–8; PROGRESS.md points here.

## The four regions

Each region has one business and one season. The levels don't run in date order: the
seasons are there for visual variety and match the costumes in the brief (Section 13).

| Levels | Region                   | Season | Business                                                  |
| ------ | ------------------------ | ------ | --------------------------------------------------------- |
| 1–3    | N. Virginia (us-east-1)  | Spring | Kitepost, a new photo-sharing app (cherry blossom photos) |
| 4–6    | Frankfurt (eu-central-1) | Autumn | The Mainufer Book Fair                                    |
| 7–9    | São Paulo (sa-east-1)    | Summer | Pé na Areia, a beachwear shop                             |
| 10–12  | Tokyo (ap-northeast-1)   | Winter | Not chosen yet                                            |

How each region's levels use its business:

- **N. Virginia.** Kitepost goes live (1), its servers move behind the load balancer
  (2), and users post photos to S3 (3).
- **Frankfurt.**
  - 4: publishers upload catalogues and cover images, and the red Cloudling wants next
    season's covers early.
  - 5: the ticket rush on opening morning.
  - 6: the bookings database survives a zone failure.
- **São Paulo.** One security arc in one shop:
  - 7: who gets in at the edge;
  - 8: who can read the data;
  - 9: how the shop's own staff get in.

Every story name is invented: no real brand or event. Havaianas is out because it is a
trademark, and the real Frankfurt book fair's name is out too.

**Continuity.** Within São Paulo, each level starts from the previous level's solved
state, locked:

- Level 8 carries Level 7's `edge-acl` (on the public subnets) and `shop-web-acl`
  (Core rule set plus rate-based, on the load balancer). A test checks they match
  Level 7's reference solution.
- Level 9 should carry Level 7's edge and Level 8's closed, encrypted stores.

Levels 1–3 already build one app step by step. In Frankfurt, each level is a different
part of the same fair's systems.

**The scenery.** São Paulo is inland: the beach city is Rio. The brief's São Paulo
horizon is a dense high-rise skyline. Keep that skyline; the shop's products (flip-flops,
bikinis, sunglasses, beach towels) carry the beach theme. The Cloudlings' summer costume
already includes flip-flops and a sun hat.

## Level 9, No Keys at the Door (São Paulo)

The brief starts with a leftover SSH 22 rule from anywhere. Simon's version tells how
that rule comes about, so the player feels why Session Manager is better.

**The scene.** Level 8's solved shop (Level 7's edge, the closed and encrypted stores),
with the web servers in private subnets. There is no SSH rule anywhere at the start, and
no NAT Gateway. Pé na Areia's admin, the operator Cloudling (distinct hat, box-shaped
kite), needs a shell on a web server: after the breach in Level 8, to check logs and
patch it.

**The steps, one change and one flight each, as in Levels 7–8:**

1. **Closed.** The red Cloudling probes port 22 and gets nowhere. Neither does the
   operator: the web servers have only private addresses, and nothing allows port 22.
   - The prober's address must be outside Level 7's block-listed range
     (198.51.100.0/24), or `edge-acl` stops it first and the lesson is lost.
2. **The careful way: a bastion host.** This is a small instance in a public subnet,
   with a public address.
   - **The bastion's security group:** SSH 22 from the operator's address only (a /32).
   - **`edge-acl` inbound:** SSH 22 from that address, numbered below the HTTPS rule's
     neighbours. Replies already leave by the outbound ephemeral rule.
   - **The web servers' security group:** SSH 22 from the bastion's security group (a
     chain, as in Level 2).

   The operator gets in, and the probe is refused at the bastion's security group. The
   narrator points out what is now there: a public machine with an open port, a private
   key to guard, a server to patch, and the probe still knocking.

3. **The twist: the operator's address changes.** The admin works from the coast for a
   weekend, a new address is locked out, and this is where teams widen the rule to
   "anywhere, just for today": which is how the brief's leftover rule comes about.
   - The narrator tells this part. The player is never asked to widen a rule.
   - **New mechanic:** a kite whose address changes between narrator steps (for example
     a per-step population override, or an event that moves the operator).
4. **The better way: Session Manager.**
   - Remove the bastion.
   - Close port 22 in both security groups and in `edge-acl`.
   - Give the web servers' role the Session Manager permission (`ssm:ManagedInstance`,
     standing for the AmazonSSMManagedInstanceCore managed policy).
   - Add a NAT Gateway, so the SSM Agent can reach the SSM endpoints over HTTPS 443.

   The operator's session is drawn from the cirrocumulus (SSM, high band) down to the
   instance. The probe now finds nothing listening anywhere.

**Objectives.**

- The operator gets a session.
- No inbound port 22 anywhere.
- Every visitor is still answered.

**★3, as in the brief.** No security group or network ACL anywhere references port 22.
After step 2 it is in two security groups and a network ACL, so this is real work.

**Why Session Manager is better** (for the narration and the fact card):

- No inbound port, and no public address or bastion host.
- No SSH keys.
- IAM decides who may start a session.
- Sessions can be logged.
- The connection runs outward, from the SSM Agent on the instance to AWS.

**"In the real world" card**, a clickable card for what the player does not configure:

- An AMI with the SSM Agent preinstalled (Amazon Linux 2 and 2023, and others).
- An instance profile whose role has the AmazonSSMManagedInstanceCore policy.
- Outbound HTTPS 443 from the instance to `ssm`, `ssmmessages` and `ec2messages`.
  - Newer agents (3.3.40.0 and later) use `ssmmessages` in place of `ec2messages` where
    they can.
- Either of two routes out:
  - through a NAT Gateway, to the public endpoints: what the game does;
  - through interface VPC endpoints (PrivateLink), out of scope here. These need a
    private DNS name switched on for each endpoint, the VPC's DNS hostnames and DNS
    support settings switched on (hostnames before private DNS), and the endpoints'
    security group allowing 443 in from the instances.

  Simon's own trouble with SSM came from that second route.

- The person starting the session needs permission too (`ssm:StartSession`), and, from
  the command line, the Session Manager plugin.

Sources to cite in the engine tests:

- [Session Manager prerequisites](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html)
- [VPC endpoints for Systems Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html)
- [Session Manager and PrivateLink](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-privatelink.html)
- [Connect with Session Manager (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/connect-to-an-amazon-ec2-instance-by-using-session-manager.html)
- [Systems Manager connectivity with VPC endpoints (re:Post)](https://repost.aws/knowledge-center/systems-manager-vpc-connectivity)

**Engine work it needs** (none of this exists yet):

- **A bastion host.**
  - EC2 instances can't have a public address yet: every instance is "private address
    only".
  - A flow from the internet to a public instance on port 22: route, network ACL, then
    security group. Journey 4 in `flow.ts` currently refuses every flow from the
    internet to an instance.
  - A flow from the bastion to a private instance on 22.
- **Session Manager.**
  - The operator flow: the SSM Agent goes out on 443 through the NAT Gateway (as for S3)
    and the role has `ssm:ManagedInstance`.
  - A new `ssm` check kind and its fizz sound.
  - Predicates: "no rule references port 22" and "the operator has a session".
- **Art.** Activate the planned `cloudling.operator.idle` and `kite.operator.flying`
  manifest entries. Add a cirrocumulus cloud for SSM and a session thread (ADR 0016).
- **The address-change mechanic** from step 3.

## Level 10, Shared Ground (Tokyo)

From the brief:

- **Scene.** Two instances in different zones, each with its own EBS volume. A legacy
  app expects a shared folder, so a file uploaded through one instance is missing
  from the other.
- **The fix.** EFS with mount targets in both zones, and a security group allowing NFS
  2049 from the app tier.
- **★3.** Mount targets in both zones.

To decide: Tokyo's business; it should naturally share files between servers.

## Level 11, Rain on Demand (Tokyo)

From the brief:

- **The flow.** An S3 upload event, an SNS topic, two SQS queues (thumbnails, audit), and
  a Lambda function on the thumbnails queue that writes to DynamoDB, with a
  least-privilege execution role.
- **The event.** Lambda is unavailable for a while. The queue fills on the weather
  station, then drains. This is the showcase level for rain as live data.
- **★3.** The role holds only `sqs:Receive` on the queue, `s3:Read` on the bucket and
  `dynamodb:Write` on the table.

## Level 12, The Grand Atlas (Tokyo)

From the brief:

- **The brief.** An empty two-zone VPC, the whole palette, and a small shop launching on
  Saturday. It must:
  - serve customers securely over HTTPS;
  - survive a crowd and the loss of a zone;
  - protect customer data;
  - keep running when the application tier fails entirely, with Route 53 failover to an
    S3 "back soon" page;
  - stay within a coin budget.
- **Kites.** Every red kite seen so far.

To decide: whether the "small shop" is Tokyo's business launching, which would tie the
finale to the region.

## Open decisions

1. **Tokyo's business.** It needs shared files (10), an event-driven upload pipeline
   (11) and a shop launch (12). It should have regional flavour with an invented name,
   and a winter season.
2. **Level 9's address change.** A per-step population override, or a timeline event.
3. **The "In the real world" card.** A new kind of fact card, or a section of the SSM
   fact card.
4. **Long narrator steps.** Several older steps (Level 2's `explain`, `chain` and `wrap`)
   run past three lines and scroll inside the narrator box. They work, but the step
   counter is hidden until the player scrolls. Shorten them when Level 2 is next
   touched.
