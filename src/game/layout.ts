// Layout: where everything is drawn. Positions are derived from the scene's
// structure (which band, which subnet), never stored in it, so a scene written
// by hand in JSON always draws correctly and "snapping" is just choosing a subnet.
//
// All coordinates are in stage pixels: the game is designed at 1280×720 and the
// whole stage is scaled to fit the window.

import {
  resourcesOfKind,
  type Resource,
  type ResourceKind,
  type ResourceRef,
  type Scene,
  type Subnet,
  type AvailabilityZone,
} from '../engine'
import manifest from '../../assets/manifest.json'

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }

export const STAGE = { width: 1280, height: 720 }

/** The ten cloud genera are the internal vocabulary for service families (brief, Section 6). */
export type CloudGenus =
  | 'stratocumulus'
  | 'cumulus'
  | 'altocumulus'
  | 'altostratus'
  | 'cumulonimbus'
  | 'cirrus'
  /** A thin veil that forms halos: a KMS key (brief, Section 6). */
  | 'cirrostratus'
  /** High rippled "mackerel sky", the control layer above everything: SSM (brief, Section 6). */
  | 'cirrocumulus'
  /** Not a cloud: AWS WAF is a woven net slung beneath the load balancer (brief, Section 6). */
  | 'net'

export const GENUS_OF: Record<ResourceKind, CloudGenus> = {
  'internet-gateway': 'stratocumulus',
  'nat-gateway': 'stratocumulus',
  'load-balancer': 'cumulus',
  'ec2-instance': 'altocumulus',
  'auto-scaling-group': 'altocumulus',
  's3-bucket': 'cumulonimbus',
  'iam-role': 'cirrus',
  // Flat, layered, steady: structured, persistent data (brief, Section 6).
  'rds-database': 'altostratus',
  'waf-web-acl': 'net',
  'kms-key': 'cirrostratus',
  'session-manager': 'cirrocumulus',
}

/** Which band of sky each kind of cloud belongs to. 'vertical' spans every band. */
export type SkyBand = 'low' | 'mid' | 'high' | 'vertical'

export const BAND_OF: Record<ResourceKind, SkyBand> = {
  'internet-gateway': 'low',
  'nat-gateway': 'low',
  'load-balancer': 'low',
  'ec2-instance': 'mid',
  'auto-scaling-group': 'mid',
  's3-bucket': 'vertical',
  'iam-role': 'high',
  'rds-database': 'mid',
  'waf-web-acl': 'low',
  'kms-key': 'high',
  'session-manager': 'high',
}

/**
 * The band one particular cloud belongs to. An instance with a public address (a
 * bastion host) faces the internet, so it sits in a public subnet in the low band;
 * every other instance is in the mid band.
 */
export function bandOf(resource: Resource): SkyBand {
  if (resource.kind === 'ec2-instance' && resource.publicAddress === true) return 'low'
  return BAND_OF[resource.kind]
}

// The fixed geometry of the sky. Altitude means distance from the internet:
// the ground is at the bottom, then low (public), mid (private), high (managed).
export const SKY = {
  /** The playfield between the palette tray (left) and the objectives panel (right). */
  left: 196,
  right: 1084,
  high: { top: 52, bottom: 152 },
  vpc: { x: 228, y: 162, width: 660, height: 312 } satisfies Rect,
  mid: { top: 174, bottom: 310 },
  low: { top: 322, bottom: 462 },
  s3Column: { x: 908, y: 64, width: 160, height: 410 } satisfies Rect,
  /** The y of the Cloudlings' feet. */
  groundY: 612,
  horizonY: 556,
}

const COLUMN_GAP = 10
const columnWidth = (SKY.vpc.width - 2 * 12 - COLUMN_GAP) / 2

function subnetRect(subnet: Subnet): Rect {
  const band = SKY[subnet.band]
  const x = SKY.vpc.x + 12 + (subnet.availabilityZone === 'a' ? 0 : columnWidth + COLUMN_GAP)
  return { x, y: band.top, width: columnWidth, height: band.bottom - band.top }
}

/** The final-art entry (assets/manifest.json) a resource is drawn with. */
export function spriteIdOf(kind: ResourceKind): keyof typeof manifest.sprites {
  if (kind === 'waf-web-acl') return 'construct.waf-net'
  return `cloud.${GENUS_OF[kind]}.${kind}` as keyof typeof manifest.sprites
}

export function spriteSize(kind: ResourceKind): { width: number; height: number } {
  const sprite = manifest.sprites[spriteIdOf(kind)]
  return { width: sprite.width, height: sprite.height }
}

/**
 * One instance in an Auto Scaling group's fleet: a single cloudlet, drawn once per
 * instance. This is its largest size; a crowded fleet draws it smaller to fit.
 */
export const FLEET_INSTANCE_SIZE = {
  width: manifest.sprites['cloud.altocumulus.fleet-instance'].width,
  height: manifest.sprites['cloud.altocumulus.fleet-instance'].height,
}

function centred(centre: Point, kind: ResourceKind): Rect {
  const { width, height } = spriteSize(kind)
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height }
}

export type SceneLayout = {
  vpc: Rect
  subnets: Record<string, Rect>
  /** The rectangle of every cloud, by resource id. */
  clouds: Record<string, Rect>
}

export function layoutScene(scene: Scene): SceneLayout {
  const subnets: Record<string, Rect> = {}
  for (const subnet of scene.subnets) subnets[subnet.id] = subnetRect(subnet)

  const clouds: Record<string, Rect> = {}
  const vpcCentreX = SKY.vpc.x + SKY.vpc.width / 2
  const lowCentreY = (SKY.low.top + SKY.low.bottom) / 2
  const midCentreY = (SKY.mid.top + SKY.mid.bottom) / 2

  // A database shares the private subnets with the web servers: they move up, so the
  // database and its caption fit below them (Level 8).
  const sharingWithDatabase = resourcesOfKind(scene, 'rds-database').length > 0
  // Resources sharing a subnet are spread side by side.
  const placeInSubnet = (kind: 'ec2-instance' | 'nat-gateway') => {
    for (const subnet of scene.subnets) {
      const members = resourcesOfKind(scene, kind).filter(
        (resource) => resource.subnetId === subnet.id,
      )
      const rect = subnets[subnet.id]
      if (!rect) continue
      members.forEach((resource, index) => {
        if (kind === 'ec2-instance' && subnet.band === 'low') {
          // A bastion host: at the outer edge of its public cell, clear of the load
          // balancer in the middle, and below a NAT Gateway if one shares the cell.
          const outerX = subnet.availabilityZone === 'a' ? rect.x + 64 : rect.x + rect.width - 64
          const sharing = resourcesOfKind(scene, 'nat-gateway').some(
            (nat) => nat.subnetId === subnet.id,
          )
          clouds[resource.id] = centred(
            { x: outerX, y: (sharing ? lowCentreY + 34 : lowCentreY - 8) + index * 70 },
            kind,
          )
        } else if (kind === 'ec2-instance') {
          const offset = (index - (members.length - 1) / 2) * 120
          clouds[resource.id] = centred(
            {
              x: rect.x + rect.width / 2 + offset,
              y: sharingWithDatabase ? SKY.mid.top + 36 : midCentreY + 4,
            },
            kind,
          )
        } else {
          // NAT Gateways sit at the outer edge of the public cell, clear of the load balancer.
          const outerX = subnet.availabilityZone === 'a' ? rect.x + 62 : rect.x + rect.width - 62
          clouds[resource.id] = centred({ x: outerX, y: lowCentreY - 26 + index * 54 }, kind)
        }
      })
    }
  }
  placeInSubnet('ec2-instance')
  placeInSubnet('nat-gateway')

  scene.resources.forEach((resource) => {
    switch (resource.kind) {
      case 'internet-gateway':
        // On the VPC's bottom border: the gate between the ground and the sky.
        clouds[resource.id] = centred(
          { x: vpcCentreX, y: SKY.vpc.y + SKY.vpc.height },
          resource.kind,
        )
        break
      case 'load-balancer':
        // One cumulus spanning both Availability Zone columns.
        clouds[resource.id] = centred({ x: vpcCentreX, y: lowCentreY + 4 }, resource.kind)
        break
      case 's3-bucket':
        clouds[resource.id] = centred(
          {
            x: SKY.s3Column.x + SKY.s3Column.width / 2,
            y: SKY.s3Column.y + SKY.s3Column.height / 2,
          },
          resource.kind,
        )
        break
      case 'iam-role': {
        const index = resourcesOfKind(scene, 'iam-role').indexOf(resource)
        clouds[resource.id] = centred(
          { x: 330 + index * 170, y: (SKY.high.top + SKY.high.bottom) / 2 },
          resource.kind,
        )
        break
      }
      case 'kms-key': {
        // Managed services share the high band: keys after the roles, nearer the bucket.
        const index =
          resourcesOfKind(scene, 'iam-role').length +
          resourcesOfKind(scene, 'kms-key').indexOf(resource)
        clouds[resource.id] = centred(
          { x: 330 + index * 170 + 40, y: (SKY.high.top + SKY.high.bottom) / 2 },
          resource.kind,
        )
        break
      }
      case 'session-manager': {
        // The control layer above everything: after the roles and keys in the high band.
        const index =
          resourcesOfKind(scene, 'iam-role').length + resourcesOfKind(scene, 'kms-key').length
        clouds[resource.id] = centred(
          { x: 330 + index * 170 + 60, y: (SKY.high.top + SKY.high.bottom) / 2 },
          resource.kind,
        )
        break
      }
      case 'auto-scaling-group': {
        // A fleet across both Availability Zone columns, one half in each, with room to
        // draw every instance (MAX_GROUP_SIZE). With fixed EC2 instances in its subnets
        // it fits between them; without, it spreads across both private subnets.
        const crowded = resourcesOfKind(scene, 'ec2-instance').some((instance) =>
          resource.subnetIds.includes(instance.subnetId),
        )
        const columns = resource.subnetIds
          .map((id) => subnets[id])
          .filter((rect): rect is Rect => rect !== undefined)
        // Sharing the mid band with a database, the fleet takes its upper part.
        const sharing = resourcesOfKind(scene, 'rds-database').length > 0
        const height = sharing ? 42 : 92
        const y = sharing ? SKY.mid.top + 22 : midCentreY + 4 - height / 2
        if (crowded || columns.length === 0) {
          clouds[resource.id] = { x: vpcCentreX - 105, y, width: 210, height }
        } else {
          const left = Math.min(...columns.map((rect) => rect.x)) + 14
          const right = Math.max(...columns.map((rect) => rect.x + rect.width)) - 14
          clouds[resource.id] = { x: left, y, width: right - left, height }
        }
        break
      }
      case 'rds-database': {
        // In the lower part of its primary's subnet; a standby, if any, sits in the
        // same place in the other zone's subnet (databaseRect).
        const subnet = scene.subnets.find((each) => each.id === resource.primarySubnetId)
        const rect = subnets[resource.primarySubnetId]
        if (rect && subnet) clouds[resource.id] = databaseSpot(rect, subnet.availabilityZone)
        break
      }
      case 'waf-web-acl': {
        // A net slung beneath the load balancer it protects, from just inside the
        // cloud's lower edge (brief, Section 6). The load balancer's caption moves inside
        // its cloud while a net hangs there, so the net has the space below to itself.
        const protectedOne = resourcesOfKind(scene, 'load-balancer').find(
          (loadBalancer) => loadBalancer.id === resource.loadBalancerId,
        )
        const above = protectedOne
          ? centred({ x: vpcCentreX, y: lowCentreY + 4 }, 'load-balancer')
          : null
        const { width, height } = spriteSize('waf-web-acl')
        clouds[resource.id] = above
          ? { x: above.x, y: above.y + above.height - 14, width, height }
          : centred({ x: vpcCentreX, y: lowCentreY + 30 }, resource.kind)
        break
      }
      case 'ec2-instance':
      case 'nat-gateway':
        break // placed above
    }
  })

  return { vpc: SKY.vpc, subnets, clouds }
}

/**
 * Where a database is drawn in a subnet: the lower part, clear of a fleet and its caption
 * above, on the side nearest the other zone. Primary and standby then sit either side of
 * the zone divider with a short bridge between them, and their captions go on the outer
 * side (databaseCaptionSide), where nothing crosses them.
 */
function databaseSpot(subnet: Rect, zone: AvailabilityZone): Rect {
  const { width, height } = spriteSize('rds-database')
  return {
    x: zone === 'a' ? subnet.x + subnet.width - width - 26 : subnet.x + 26,
    y: subnet.y + subnet.height - height - 10,
    width,
    height,
  }
}

/** Which side of a database's cloud its caption goes: away from the zone divider. */
export const databaseCaptionSide = (zone: AvailabilityZone): 'left' | 'right' =>
  zone === 'a' ? 'left' : 'right'

/**
 * Where a database's copy in an Availability Zone is drawn: its primary or its
 * standby, in that zone's subnet of its DB subnet group. Null if it has no subnet there.
 */
export function databaseRect(
  scene: Scene,
  layout: SceneLayout,
  database: { subnetIds: string[] },
  zone: AvailabilityZone,
): Rect | null {
  const subnetId = database.subnetIds.find(
    (id) => scene.subnets.find((subnet) => subnet.id === id)?.availabilityZone === zone,
  )
  const rect = subnetId ? layout.subnets[subnetId] : undefined
  return rect ? databaseSpot(rect, zone) : null
}

export const centreOf = (rect: Rect): Point => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
})

export const contains = (rect: Rect, point: Point): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height

/**
 * The VPC's address-range caption above its top border ("VPC 10.0.0.0/16" and its
 * "i"). Clicking it opens the CIDR card.
 */
export function cidrLabelRect(): Rect {
  return { x: SKY.vpc.x + SKY.vpc.width - 250, y: SKY.vpc.y - 26, width: 168, height: 22 }
}

/** Where a Cloudling stands, for ground positions 0 (left) to 6 (right). */
export function cloudlingPosition(groundPosition: number): Point {
  return { x: 290 + groundPosition * 112, y: SKY.groundY }
}

/** Where a Cloudling's kite hovers before it flies. */
export function kiteRestPosition(groundPosition: number): Point {
  const cloudling = cloudlingPosition(groundPosition)
  return { x: cloudling.x + 22, y: cloudling.y - 92 }
}

/** The connector handle of a cloud: a small knob on its right edge. */
export function handlePosition(rect: Rect): Point {
  return { x: rect.x + rect.width - 4, y: rect.y + rect.height / 2 }
}

function closestPointOnBorder(rect: Rect, point: Point): Point {
  const x = Math.min(Math.max(point.x, rect.x), rect.x + rect.width)
  const y = Math.min(Math.max(point.y, rect.y), rect.y + rect.height)
  const inside = contains(rect, point)
  if (!inside) return { x, y }
  // Inside the rectangle: snap to the nearest edge.
  const distances = [
    { edge: { x: rect.x, y }, distance: x - rect.x },
    { edge: { x: rect.x + rect.width, y }, distance: rect.x + rect.width - x },
    { edge: { x, y: rect.y }, distance: y - rect.y },
    { edge: { x, y: rect.y + rect.height }, distance: rect.y + rect.height - y },
  ]
  distances.sort((first, second) => first.distance - second.distance)
  return distances[0]?.edge ?? { x, y }
}

/**
 * Where a straight line from `from` to `to` crosses a subnet's fence, going in or coming
 * out. A boundary check belongs on the stretch of fence the kite (or rain) actually
 * crosses: a reply leaving for the internet is stopped at the edge facing the gateway,
 * not at the edge it came in by. When the line misses the rectangle (a load balancer is
 * drawn straddling two subnets, so its centre can sit just outside either), the nearest
 * point of fence to where it is coming from, or going to, stands in.
 */
export function borderCrossing(
  rect: Rect,
  from: Point,
  to: Point,
  direction: 'enter' | 'exit',
): Point {
  const fallback = () =>
    direction === 'enter' ? closestPointOnBorder(rect, from) : closestPointOnBorder(rect, to)
  // Liang–Barsky clipping of the segment against the rectangle.
  const dx = to.x - from.x
  const dy = to.y - from.y
  const sides: [number, number][] = [
    [-dx, from.x - rect.x],
    [dx, rect.x + rect.width - from.x],
    [-dy, from.y - rect.y],
    [dy, rect.y + rect.height - from.y],
  ]
  let enter = 0
  let exit = 1
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return fallback()
      continue
    }
    const t = q / p
    if (p < 0) enter = Math.max(enter, t)
    else exit = Math.min(exit, t)
  }
  if (enter > exit) return fallback()
  const at = (t: number): Point => ({ x: from.x + dx * t, y: from.y + dy * t })
  if (direction === 'enter') return enter > 0 || !contains(rect, from) ? at(enter) : fallback()
  return exit < 1 ? at(exit) : fallback()
}

/**
 * Turns a trace step's location into a point on the stage.
 * `previous` is where the kite was, so boundary checks land on the nearest stretch of fence.
 */
export function positionOfRef(
  scene: Scene,
  layout: SceneLayout,
  ref: ResourceRef,
  cloudling: Point,
  previous: Point,
): Point {
  switch (ref.kind) {
    case 'ground':
      return { x: cloudling.x, y: cloudling.y - 60 }
    case 'vpc': {
      // The gate, if there is one; otherwise the stretch of border above the Cloudling.
      const gateway = resourcesOfKind(scene, 'internet-gateway')[0]
      const gate = gateway ? layout.clouds[gateway.id] : undefined
      if (gate) return centreOf(gate)
      const x = Math.min(
        Math.max(cloudling.x, layout.vpc.x + 20),
        layout.vpc.x + layout.vpc.width - 20,
      )
      return { x, y: layout.vpc.y + layout.vpc.height }
    }
    case 'subnet': {
      const rect = layout.subnets[ref.id]
      return rect ? closestPointOnBorder(rect, previous) : previous
    }
    case 'resource': {
      // An Auto Scaling group's instances ("asg#2") are drawn as their group's cloud.
      const rect = layout.clouds[ref.id] ?? layout.clouds[ref.id.split('#')[0] ?? '']
      return rect ? centreOf(rect) : previous
    }
  }
}

// ---------------------------------------------------------------------------
// Pointer targets and snapping
// ---------------------------------------------------------------------------

export type Target =
  | { kind: 'resource'; id: string }
  | { kind: 'handle'; resourceId: string }
  | { kind: 'subnet'; id: string }
  | { kind: 'kite'; id: string }

export function resourceAt(scene: Scene, layout: SceneLayout, point: Point): Resource | undefined {
  // Later resources are drawn on top, so search from the end.
  return [...scene.resources].reverse().find((resource) => {
    const rect = layout.clouds[resource.id]
    return rect !== undefined && contains(rect, point)
  })
}

export function subnetAt(scene: Scene, layout: SceneLayout, point: Point): Subnet | undefined {
  return scene.subnets.find((subnet) => {
    const rect = layout.subnets[subnet.id]
    return rect !== undefined && contains(rect, point)
  })
}

/**
 * A place a cloud may be dropped: a valid subnet cell for subnet-bound kinds, or the
 * cloud's band of sky for the rest. While a cloud is dragged, the zone under the
 * pointer lights up; letting go anywhere else is not a placement.
 */
export type DropZone = {
  rect: Rect
  /** The subnet a cloud dropped here lands in, for subnet-bound kinds. */
  subnetId?: string
}

/** Every zone a cloud of this kind may be dropped in. */
export function dropZones(
  layout: SceneLayout,
  kind: ResourceKind,
  validSubnets: Subnet[],
): DropZone[] {
  if (validSubnets.length > 0) {
    return validSubnets.flatMap((subnet) => {
      const rect = layout.subnets[subnet.id]
      return rect ? [{ rect, subnetId: subnet.id }] : []
    })
  }
  switch (BAND_OF[kind]) {
    case 'low':
      // The low band inside the VPC, down to and including its bottom border.
      return [
        {
          rect: {
            x: SKY.vpc.x + 12,
            y: SKY.low.top,
            width: SKY.vpc.width - 24,
            height: SKY.low.bottom - SKY.low.top + 34,
          },
        },
      ]
    case 'high':
      return [
        {
          rect: {
            x: SKY.vpc.x,
            y: SKY.high.top,
            width: SKY.vpc.width,
            height: SKY.high.bottom - SKY.high.top,
          },
        },
      ]
    case 'mid':
      // The mid band inside the VPC: an Auto Scaling group spans both private subnets.
      return [
        {
          rect: {
            x: SKY.vpc.x + 12,
            y: SKY.mid.top,
            width: SKY.vpc.width - 24,
            height: SKY.mid.bottom - SKY.mid.top,
          },
        },
      ]
    case 'vertical':
      return [{ rect: SKY.s3Column }]
  }
}

/** The zone under the pointer, if any. Only a drop inside a zone places a cloud. */
export function zoneAt(zones: DropZone[], point: Point): DropZone | undefined {
  return zones.find((zone) => contains(zone.rect, point))
}
