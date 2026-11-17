# Simplifications

Every deliberate departure from real AWS behaviour. The rule (brief, Section 2):
simplify by leaving features out, never by bending the behaviour of what is included.
Each entry says what differs, why, and where the player is told.

"Disclosed in" names a fact card id in `content/fact-cards.json`. Fact cards are
opened from the "What is this?" link on each config card.

| #   | Area              | In the game                                                                                                                    | In AWS                                                                  | Why                                                                                 | Disclosed in                 |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| 1   | Ports             | Rules pick from eight named port options                                                                                       | Any port or range                                                       | Keeps rules readable; covers every case the levels teach                            | `security-group`             |
| 2   | Addresses         | Rule sources are "anywhere" or one of a few named ranges; Cloudlings use the documentation ranges                              | Any CIDR                                                                | CIDR arithmetic is out of scope                                                     | `network-acl`                |
| 3   | Instances         | Instances never have public addresses                                                                                          | An instance in a public subnet can have one                             | Keeps the altitude rule exact: nothing in the mid band is reachable from the ground | `ec2-instance`               |
| 4   | Load balancer     | Targets always receive traffic on HTTP 80; the load balancer terminates HTTPS                                                  | The target port and protocol are configurable                           | One fewer setting; the arrangement itself is real and common                        | `load-balancer`              |
| 5   | Load balancer     | One listener, one target group, no listener rules; certificates assumed                                                        | Several listeners, rules and target groups; certificates from ACM       | Out of scope for Cloud Practitioner                                                 | `load-balancer`              |
| 6   | Load balancer     | Health is judged instantly from the current scene                                                                              | Health checks take several intervals to change state                    | No waiting during play; the outcome is the same once settled                        | `load-balancer`              |
| 7   | Load balancer     | The node a kite arrives at and the target it is sent to rotate by the kite's place in the run                                  | DNS and round robin make these choices                                  | Keeps the engine deterministic                                                      | `load-balancer`              |
| 8   | NACLs             | Replies are checked against one representative ephemeral port (49152)                                                          | A client may use any port in its ephemeral range                        | Any rule covering 1024–65535 behaves identically                                    | `network-acl`                |
| 9   | IAM               | Policies are action families (`s3:Read`, `s3:Write`…) on one resource or `*`; no conditions, groups, users, boundaries or SCPs | Fine-grained actions, ARNs with paths, conditions and more policy types | Cloud Practitioner level                                                            | `iam-role`                   |
| 10  | IAM               | The caller is always an instance's role or anonymous                                                                           | Users, access keys, federated identities                                | No access keys exist in the game                                                    | `iam-role`                   |
| 11  | S3                | Block Public Access is one switch                                                                                              | Four settings, at account and bucket level                              | The four are almost always used together                                            | `s3-bucket`                  |
| 12  | S3                | Bucket policies grant to "everyone" or to a named role; no ACLs                                                                | Any principal, conditions, ACLs                                         | Scope                                                                               | `s3-bucket`                  |
| 13  | S3                | The S3 endpoint is one illustrative address (52.216.0.10)                                                                      | Many published ranges                                                   | Rules cannot name it anyway                                                         | not shown to players         |
| 14  | Gateway endpoints | No endpoint policies                                                                                                           | Endpoint policies can restrict access                                   | Listed in the brief                                                                 | `gateway-endpoint` (Level 4) |
| 15  | VPC               | One VPC, 10.0.0.0/16, IPv4 only; subnets and their CIDRs are fixed by the level                                                | Any layout                                                              | Scope                                                                               | `vpc`                        |

Entries for services not yet built (WAF, Auto Scaling, RDS, DynamoDB, Lambda, SQS,
SNS, KMS, SSM, Route 53, CloudWatch, cost) will be added with them. The brief already
lists several: Lambda and DynamoDB drawn in the mid band; SSM reached through NAT
because interface endpoints are omitted; DNS caching omitted; cost in illustrative units.

## Audit

Last checked against the code: end of Milestone 2. To re-audit, search `src/engine/`
for the word "simplif" and for constants in `ports.ts` and `address.ts`.
