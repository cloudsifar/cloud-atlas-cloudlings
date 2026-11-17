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
} from '../engine'
import manifest from '../../assets/manifest.json'

export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }

export const STAGE = { width: 1280, height: 720 }

/** The ten cloud genera are the internal vocabulary for service families (brief, Section 6). */
export type CloudGenus = 'stratocumulus' | 'cumulus' | 'altocumulus' | 'cumulonimbus' | 'cirrus'

export const GENUS_OF: Record<ResourceKind, CloudGenus> = {
  'internet-gateway': 'stratocumulus',
  'nat-gateway': 'stratocumulus',
  'load-balancer': 'cumulus',
  'ec2-instance': 'altocumulus',
  's3-bucket': 'cumulonimbus',
  'iam-role': 'cirrus',
}

/** Which band of sky each kind of cloud belongs to. 'vertical' spans every band. */
export type SkyBand = 'low' | 'mid' | 'high' | 'vertical'

export const BAND_OF: Record<ResourceKind, SkyBand> = {
  'internet-gateway': 'low',
  'nat-gateway': 'low',
  'load-balancer': 'low',
  'ec2-instance': 'mid',
  's3-bucket': 'vertical',
  'iam-role': 'high',
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

export function spriteSize(kind: ResourceKind): { width: number; height: number } {
  const id = `cloud.${GENUS_OF[kind]}.${kind}` as keyof typeof manifest.sprites
  const sprite = manifest.sprites[id]
  return { width: sprite.width, height: sprite.height }
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

  // Resources sharing a subnet are spread side by side.
  const placeInSubnet = (kind: 'ec2-instance' | 'nat-gateway') => {
    for (const subnet of scene.subnets) {
      const members = resourcesOfKind(scene, kind).filter(
        (resource) => resource.subnetId === subnet.id,
      )
      const rect = subnets[subnet.id]
      if (!rect) continue
      members.forEach((resource, index) => {
        if (kind === 'ec2-instance') {
          const offset = (index - (members.length - 1) / 2) * 120
          clouds[resource.id] = centred(
            { x: rect.x + rect.width / 2 + offset, y: midCentreY + 4 },
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
      case 'ec2-instance':
      case 'nat-gateway':
        break // placed above
    }
  })

  return { vpc: SKY.vpc, subnets, clouds }
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
      const rect = layout.clouds[ref.id]
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

export type Snap = {
  /** The subnet the cloud lands in, for subnet-bound kinds. */
  subnetId?: string
  /** True if the player dropped it outside its band and it drifted to a valid place. */
  drifted: boolean
}

/** The vertical extent of each band, for deciding whether a drop was "in the right band". */
function bandExtent(band: SkyBand): { top: number; bottom: number } {
  switch (band) {
    case 'low':
      return { top: SKY.low.top - 10, bottom: SKY.vpc.y + SKY.vpc.height + 40 }
    case 'mid':
      return SKY.mid
    case 'high':
      return SKY.high
    case 'vertical':
      return { top: SKY.high.top, bottom: SKY.low.bottom }
  }
}

/**
 * Every cloud snaps to its band. Given where the player let go, work out where
 * the cloud belongs: the nearest valid subnet for subnet-bound kinds, and whether
 * the drop was outside the cloud's own band.
 */
export function snapDrop(
  layout: SceneLayout,
  kind: ResourceKind,
  point: Point,
  validSubnets: Subnet[],
): Snap {
  const extent = bandExtent(BAND_OF[kind])
  const insideSky = point.x >= SKY.left && point.x <= SKY.right
  const inBand = insideSky && point.y >= extent.top && point.y <= extent.bottom
  if (validSubnets.length === 0) return { drifted: !inBand }

  const nearest = [...validSubnets].sort((first, second) => {
    const distance = (subnet: Subnet) => {
      const rect = layout.subnets[subnet.id]
      return rect ? Math.abs(centreOf(rect).x - point.x) : Infinity
    }
    return distance(first) - distance(second)
  })[0]
  const rect = nearest ? layout.subnets[nearest.id] : undefined
  return { subnetId: nearest?.id, drifted: !(rect && contains(rect, point)) && !inBand }
}

/** The rectangles to highlight as valid places while a cloud of this kind is being dragged. */
export function validDropZones(
  layout: SceneLayout,
  kind: ResourceKind,
  validSubnets: Subnet[],
): Rect[] {
  if (validSubnets.length > 0) {
    return validSubnets
      .map((subnet) => layout.subnets[subnet.id])
      .filter((rect): rect is Rect => rect !== undefined)
  }
  switch (BAND_OF[kind]) {
    case 'low':
      return [
        {
          x: SKY.vpc.x + 12,
          y: SKY.low.top,
          width: SKY.vpc.width - 24,
          height: SKY.low.bottom - SKY.low.top + 34,
        },
      ]
    case 'high':
      return [
        {
          x: SKY.vpc.x,
          y: SKY.high.top,
          width: SKY.vpc.width,
          height: SKY.high.bottom - SKY.high.top,
        },
      ]
    case 'vertical':
      return [SKY.s3Column]
    case 'mid':
      return []
  }
}
