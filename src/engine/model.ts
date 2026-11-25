// The AWS model: plain data describing everything the player can build.
//
// A `Scene` is the whole sky at one moment. It is ordinary JSON-compatible data
// (no classes, no functions), so a scene can be stored in a level file, copied
// for undo, and compared in tests. Every engine function takes a scene and
// returns a new value; nothing in here is ever mutated by the engine.

// ---------------------------------------------------------------------------
// Network building blocks
// ---------------------------------------------------------------------------

export type AvailabilityZone = 'a' | 'b'

/** Which band of sky a subnet cell is drawn in. The altitude rule: low = edge, mid = private tiers. */
export type Band = 'low' | 'mid'

/**
 * The named port choices offered to the player (brief, Section 7).
 * Rules never hold raw numbers, so a rule can only ever say something the game teaches.
 */
export type PortOption =
  'http' | 'https' | 'ssh' | 'mysql' | 'postgresql' | 'nfs' | 'ephemeral' | 'all'

/** An address range a rule can name. */
export type CidrPeer = { kind: 'anywhere' } | { kind: 'cidr'; cidr: string }

/** Security group rules can additionally point at another security group. NACL rules cannot. */
export type SecurityGroupPeer = CidrPeer | { kind: 'security-group'; securityGroupId: string }

export type Vpc = { cidr: string }

export type Subnet = {
  id: string
  name: string
  availabilityZone: AvailabilityZone
  band: Band
  cidr: string
  /** Exactly one route table per subnet. */
  routeTableId: string
  /** Exactly one network ACL per subnet. */
  networkAclId: string
}

/** Route destinations are named options, not free-form CIDRs. The VPC-local route is implicit. */
export type RouteDestination = 'internet' | 's3' | 'dynamodb'

export type RouteTarget =
  | { kind: 'internet-gateway' }
  | { kind: 'nat-gateway'; natGatewayId: string }
  | { kind: 'gateway-endpoint'; service: 's3' | 'dynamodb' }

export type Route = { destination: RouteDestination; target: RouteTarget }

export type RouteTable = { id: string; name: string; routes: Route[] }

export type NetworkAclRule = {
  number: number
  action: 'allow' | 'deny'
  /** Inbound rules match the packet's source; outbound rules match its destination. */
  peer: CidrPeer
  ports: PortOption
}

export type NetworkAcl = {
  id: string
  name: string
  inbound: NetworkAclRule[]
  outbound: NetworkAclRule[]
}

/** Security group rules only ever allow; there is no `action` field because deny does not exist. */
export type SecurityGroupRule = { ports: PortOption; peer: SecurityGroupPeer }

export type SecurityGroup = {
  id: string
  name: string
  inbound: SecurityGroupRule[]
  outbound: SecurityGroupRule[]
}

// ---------------------------------------------------------------------------
// IAM
// ---------------------------------------------------------------------------

/** Policies are simplified to action families (brief, Section 7). */
export type ServiceAction =
  | 's3:Read'
  | 's3:Write'
  | 's3:Delete'
  | 'dynamodb:Read'
  | 'dynamodb:Write'
  | 'sqs:Send'
  | 'sqs:Receive'
  | 'sns:Publish'
  | 'kms:Use'
  | 'ssm:ManagedInstance'

export type PolicyStatement = {
  effect: 'allow' | 'deny'
  actions: ServiceAction[]
  /** The id of one resource, or '*' for every resource. */
  resource: string
}

export type BucketPolicyStatement = {
  effect: 'allow' | 'deny'
  /** 'everyone' is the public principal ("Principal": "*"). */
  principal: { kind: 'everyone' } | { kind: 'role'; roleId: string }
  actions: ServiceAction[]
}

// ---------------------------------------------------------------------------
// Resources (the clouds)
// ---------------------------------------------------------------------------

/** Present in the scene = attached to the VPC. */
export type InternetGateway = { kind: 'internet-gateway'; id: string; name: string }

export type NatGateway = { kind: 'nat-gateway'; id: string; name: string; subnetId: string }

export type LoadBalancer = {
  kind: 'load-balancer'
  id: string
  name: string
  scheme: 'internet-facing' | 'internal'
  /** The subnets holding the load balancer's nodes: one per Availability Zone. */
  subnetIds: string[]
  securityGroupIds: string[]
  /** HTTP listens on port 80, HTTPS on port 443 (certificates assumed). */
  listener: 'http' | 'https'
  /** Ids of registered EC2 instances. */
  targetIds: string[]
}

export type Ec2Instance = {
  kind: 'ec2-instance'
  id: string
  name: string
  subnetId: string
  securityGroupIds: string[]
  /** The IAM role attached through an instance profile, if any. */
  roleId: string | null
  size: 'small' | 'medium' | 'large'
  /** False when the instance has failed; events flip this. */
  healthy: boolean
}

export type S3Bucket = {
  kind: 's3-bucket'
  id: string
  name: string
  /** On by default in AWS, and on by default here. */
  blockPublicAccess: boolean
  policy: BucketPolicyStatement[]
  /** What the bucket holds: decides whether public access is a breach or a legitimate website. */
  dataClass: 'sensitive' | 'public-content'
  /** New objects are always encrypted at rest; SSE-S3 is the default since January 2023. */
  encryption: { kind: 'sse-s3' }
}

export type IamRole = { kind: 'iam-role'; id: string; name: string; statements: PolicyStatement[] }

/**
 * A target tracking scaling policy: "keep average CPU near this percentage".
 * EC2 Auto Scaling creates and manages the CloudWatch alarms for it.
 */
export type TargetTrackingPolicy = { targetCpuPercent: number }

/**
 * An Auto Scaling group: a fleet of identical instances whose size can change.
 * Its instances are not stored; they are derived from `desired` (see autoScaling.ts),
 * which is what makes "replace the fixed instances with a group" a small edit.
 */
export type AutoScalingGroup = {
  kind: 'auto-scaling-group'
  id: string
  name: string
  /** The subnets (and so the Availability Zones) instances are spread across. */
  subnetIds: string[]
  securityGroupIds: string[]
  roleId: string | null
  size: Ec2Instance['size']
  min: number
  /** How many instances the group is trying to keep running. Always within min..max. */
  desired: number
  max: number
  /** null means the group never changes size by itself. */
  scaling: TargetTrackingPolicy | null
}

/**
 * An RDS database (a DB instance). AWS behaviour modelled (docs/ENGINE.md, "Databases"):
 * - It lives in private subnets: its DB subnet group must cover at least two
 *   Availability Zones, even when it runs in one, so that it can become Multi-AZ.
 * - Its security group must allow the engine port (MySQL 3306, PostgreSQL 5432) from
 *   whatever calls it, ideally by naming the application tier's security group.
 * - Multi-AZ keeps a synchronous standby in another Availability Zone. The standby
 *   serves nothing until the primary's AZ fails; then RDS fails over to it, which takes
 *   a couple of minutes, and the database's endpoint follows the new primary.
 * - Without Multi-AZ, a failure of the primary's AZ takes the database down.
 */
export type RdsDatabase = {
  kind: 'rds-database'
  id: string
  name: string
  engine: 'mysql' | 'postgresql'
  /** The DB subnet group: private subnets in at least two Availability Zones. */
  subnetIds: string[]
  securityGroupIds: string[]
  /** The subnet the primary runs in: one of `subnetIds`. */
  primarySubnetId: string
  /** A standby in another Availability Zone of the subnet group, ready to take over. */
  multiAz: boolean
  /**
   * Set by events, never by the player: 'failing-over' while the standby takes over,
   * 'unavailable' when the primary's AZ has failed and there is no standby.
   */
  status: 'available' | 'failing-over' | 'unavailable'
}

export type Resource =
  | InternetGateway
  | NatGateway
  | LoadBalancer
  | Ec2Instance
  | AutoScalingGroup
  | S3Bucket
  | IamRole
  | RdsDatabase

export type ResourceKind = Resource['kind']

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

export type Scene = {
  vpc: Vpc
  subnets: Subnet[]
  routeTables: RouteTable[]
  networkAcls: NetworkAcl[]
  securityGroups: SecurityGroup[]
  resources: Resource[]
  /**
   * Availability Zones that are down: set by an event during a run (timeline.ts,
   * `az-failure`), never by the player or a level's scene. Absent means none.
   */
  failedZones?: AvailabilityZone[]
}

/** Whether a subnet's Availability Zone is down. */
export function subnetIsDown(scene: Scene, subnet: Subnet): boolean {
  return scene.failedZones?.includes(subnet.availabilityZone) ?? false
}

// ---------------------------------------------------------------------------
// Lookups. Small helpers so rule code reads as rules, not as array searches.
// ---------------------------------------------------------------------------

export function findResource(scene: Scene, id: string): Resource | undefined {
  return scene.resources.find((resource) => resource.id === id)
}

export function findResourceOfKind<K extends ResourceKind>(
  scene: Scene,
  kind: K,
  id: string,
): Extract<Resource, { kind: K }> | undefined {
  const resource = findResource(scene, id)
  return resource?.kind === kind ? (resource as Extract<Resource, { kind: K }>) : undefined
}

export function resourcesOfKind<K extends ResourceKind>(
  scene: Scene,
  kind: K,
): Extract<Resource, { kind: K }>[] {
  return scene.resources.filter(
    (resource): resource is Extract<Resource, { kind: K }> => resource.kind === kind,
  )
}

/** Throws if the id is unknown: `validateScene` guarantees ids resolve before evaluation. */
export function requireSubnet(scene: Scene, id: string): Subnet {
  const subnet = scene.subnets.find((candidate) => candidate.id === id)
  if (!subnet) throw new Error(`Scene has no subnet "${id}"`)
  return subnet
}

export function requireRouteTable(scene: Scene, id: string): RouteTable {
  const table = scene.routeTables.find((candidate) => candidate.id === id)
  if (!table) throw new Error(`Scene has no route table "${id}"`)
  return table
}

export function requireNetworkAcl(scene: Scene, id: string): NetworkAcl {
  const acl = scene.networkAcls.find((candidate) => candidate.id === id)
  if (!acl) throw new Error(`Scene has no network ACL "${id}"`)
  return acl
}

export function requireSecurityGroup(scene: Scene, id: string): SecurityGroup {
  const group = scene.securityGroups.find((candidate) => candidate.id === id)
  if (!group) throw new Error(`Scene has no security group "${id}"`)
  return group
}
