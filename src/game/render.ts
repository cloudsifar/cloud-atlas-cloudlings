// Drawing the sky. One function, `drawSky`, paints a whole frame from a view
// model; it keeps no state of its own and decides nothing about the game.
//
// The visual grammar (brief, Section 5) is fixed: altitude means distance from
// the internet, each control blocks with its own object, gold means only "a
// change took effect", red-with-smoke means compromised.

import {
  isPublicSubnet,
  resolveRoute,
  resourcesOfKind,
  groupInstances,
  runningCount,
  type AutoScalingGroup,
  type AvailabilityZone,
  type CheckKind,
  type CrowdRecord,
  type RdsDatabase,
  type Resource,
  type ResourceKind,
  type Scene,
} from '../engine'
import type { Kite, Level, RegionCode } from '../levels'
import { canStartConnection } from './edits'
import { CHECK_LABELS } from './labels'
import {
  BAND_OF,
  centreOf,
  cidrLabelRect,
  cloudlingPosition,
  databaseCaptionSide,
  databaseRect,
  GENUS_OF,
  handlePosition,
  SKY,
  spriteSize,
  STAGE,
  zoneAt,
  type DropZone,
  type Point,
  type Rect,
  type SceneLayout,
} from './layout'
import {
  CAPTION_FONT,
  drawCloud,
  drawCloudling,
  drawKite,
  drawString,
  PENCIL,
  type Mood,
} from './placeholderArt'
import {
  alarmAt,
  alongPath,
  bellRingingAt,
  crowdFrameAt,
  crowdSpots,
  crowdStream,
  databaseViewAt,
  dialCpuAt,
  fleetViewAt,
  memberViewAt,
  outageAt,
  WEATHER_STATION,
  type CrowdFrame,
  type FleetView,
} from './crowdPlayback'
import { frameAt, type KiteFrame, type KiteScript } from './playback'

const PAPER = '#f6efdc'

/** Cloud blues by altitude: palest low, deepest high. The shade carries no other meaning. */
const BAND_TINT = { low: '#d6e8f6', mid: '#aecfeb', high: '#86b4dc' }
const GREY_TINT = '#c4c4c8'

/** Subnet cells: an open meadow green for public, a shaded lavender for private. Never gold. */
export const SUBNET_TINT = {
  public: 'rgba(206, 238, 212, 0.55)',
  private: 'rgba(204, 199, 232, 0.5)',
}

/** The band names lettered up the left margin of the sky. */
export const BAND_LABELS = {
  high: 'High – account',
  mid: 'Mid – private',
  low: 'Low – public',
}
const RED_TINT = '#eba5a0'

type RegionTheme = {
  skyTop: string
  skyBottom: string
  groundTop: string
  groundBottom: string
  /** The colour of the regional costume (the costume itself is an overlay in the final art). */
  costume: string
  skyline: (context: CanvasRenderingContext2D, baseY: number) => void
}

function boxes(
  context: CanvasRenderingContext2D,
  baseY: number,
  shapes: [number, number, number][],
): void {
  for (const [x, width, height] of shapes) context.fillRect(x, baseY - height, width, height)
}

const REGION_THEMES: Record<RegionCode, RegionTheme> = {
  // N. Virginia in spring: data-centre sheds, the Washington Monument and Capitol dome far off.
  'us-east-1': {
    skyTop: '#cfe6f7',
    skyBottom: '#eef6f4',
    groundTop: '#a9d18e',
    groundBottom: '#86b96c',
    costume: '#e8bd3f', // raincoat yellow
    skyline(context, baseY) {
      boxes(context, baseY, [
        [230, 120, 18],
        [370, 90, 24],
        [480, 140, 16],
        [820, 110, 20],
        [950, 90, 15],
      ])
      context.fillRect(668, baseY - 62, 7, 62) // the monument
      context.beginPath()
      context.moveTo(668, baseY - 62)
      context.lineTo(671.5, baseY - 72)
      context.lineTo(675, baseY - 62)
      context.fill()
      context.fillRect(720, baseY - 16, 70, 16) // the Capitol
      context.beginPath()
      context.arc(755, baseY - 16, 15, Math.PI, 0)
      context.fill()
      context.fillRect(753, baseY - 40, 4, 10)
    },
  },
  'eu-central-1': {
    skyTop: '#cdd9e4',
    skyBottom: '#e9eef0',
    groundTop: '#8fbf7a',
    groundBottom: '#6fa35f',
    costume: '#b5553c',
    skyline: (context, baseY) =>
      boxes(context, baseY, [
        [300, 26, 70],
        [340, 30, 92],
        [384, 24, 60],
        [520, 8, 84],
        [700, 60, 22],
      ]),
  },
  'sa-east-1': {
    skyTop: '#f6dcc0',
    skyBottom: '#faeedd',
    groundTop: '#b7b36a',
    groundBottom: '#a39a52',
    costume: '#4fa3a0',
    skyline: (context, baseY) =>
      boxes(context, baseY, [
        [240, 30, 50],
        [276, 26, 66],
        [308, 34, 44],
        [420, 28, 72],
        [454, 30, 54],
        [640, 26, 62],
        [672, 34, 48],
        [800, 30, 58],
      ]),
  },
  'ap-northeast-1': {
    skyTop: '#e3d2ea',
    skyBottom: '#f6e6ea',
    groundTop: '#a9bd9a',
    groundBottom: '#90a684',
    costume: '#5a6fb0',
    skyline: (context, baseY) =>
      boxes(context, baseY, [
        [300, 30, 48],
        [338, 26, 64],
        [520, 6, 110],
        [511, 24, 40],
        [700, 32, 56],
        [740, 26, 40],
      ]),
  },
}

export type DragView =
  | { kind: 'place'; resourceKind: ResourceKind; point: Point; zones: DropZone[] }
  | { kind: 'connect'; from: Point; to: Point }

/** How long a Cloudling's speech bubble stays up after it is clicked, in milliseconds. */
export const SPEECH_DURATION = 4200

export type SkyViewModel = {
  level: Level
  scene: Scene
  layout: SceneLayout
  /** Animation clock, in milliseconds. */
  time: number
  lockedIds: string[]
  editable: boolean
  /** The kites' timetable, and how far into it we are. Empty when there is no run to show. */
  scripts: KiteScript[]
  runTime: number
  /** For crowd levels: the crowd simulation on show, played on the same clock. Null otherwise. */
  crowd: CrowdRecord | null
  /** Resources a hostile kite has got into; they stay red until the cause is fixed. */
  compromisedIds: string[]
  /** When each recently changed resource began to glow gold (animation-clock time). */
  sunlightStartedAt: Record<string, number>
  /** 'resource:<id>' or 'subnet:<id>': what the narrator or a hint is pointing at. */
  /** The clouds or subnets the narrator is pointing at: 'resource:<id>' or 'subnet:<id>'. */
  highlights: readonly string[]
  selectedKiteId: string | null
  drag: DragView | null
  /** The Cloudling saying what it wants, and for how long it has been saying it. */
  speech: { kiteId: string; age: number } | null
  reducedMotion: boolean
}

const SUNLIGHT_DURATION = 1100

function caption(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size = 13,
  align: CanvasTextAlign = 'center',
  colour = '#3d3a48',
): void {
  context.save()
  context.font = `${size}px ${CAPTION_FONT}`
  context.textAlign = align
  context.textBaseline = 'middle'
  // A paper-coloured halo keeps hand-lettered captions legible over the sky.
  context.lineWidth = 3
  context.strokeStyle = 'rgba(246, 239, 220, 0.85)'
  context.lineJoin = 'round'
  context.strokeText(text, x, y)
  context.fillStyle = colour
  context.fillText(text, x, y)
  context.restore()
}

/** A group's instances by zone when it is not flying: spread evenly across its subnets. */
function restingZones(group: AutoScalingGroup, scene: Scene): FleetView['zones'] {
  const zones: FleetView['zones'] = {
    a: { serving: 0, launching: 0, leaving: 0, failed: 0, terminating: 0 },
    b: { serving: 0, launching: 0, leaving: 0, failed: 0, terminating: 0 },
  }
  for (const instance of groupInstances(group)) {
    const zone = scene.subnets.find((subnet) => subnet.id === instance.subnetId)?.availabilityZone
    if (zone) zones[zone].serving += 1
  }
  return zones
}

/** Whether any load balancer sends requests to this cloud. */
function isAttached(scene: Scene, resourceId: string): boolean {
  return resourcesOfKind(scene, 'load-balancer').some((loadBalancer) =>
    loadBalancer.targetIds.includes(resourceId),
  )
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  rect: Rect,
  radius: number,
  grow = 0,
): void {
  context.beginPath()
  context.roundRect(
    rect.x - grow,
    rect.y - grow,
    rect.width + grow * 2,
    rect.height + grow * 2,
    radius,
  )
}

// ---------------------------------------------------------------------------
// Backdrop: paper, sky, horizon, ground
// ---------------------------------------------------------------------------

function drawBackdrop(context: CanvasRenderingContext2D, theme: RegionTheme): void {
  context.fillStyle = PAPER
  context.fillRect(0, 0, STAGE.width, STAGE.height)

  const sky = context.createLinearGradient(0, 0, 0, SKY.horizonY)
  sky.addColorStop(0, theme.skyTop)
  sky.addColorStop(1, theme.skyBottom)
  context.fillStyle = sky
  context.fillRect(0, 0, STAGE.width, SKY.horizonY)

  // The skyline is distant scenery: low contrast, never competing with the game.
  context.fillStyle = 'rgba(96, 108, 138, 0.2)'
  theme.skyline(context, SKY.horizonY)

  const ground = context.createLinearGradient(0, SKY.horizonY, 0, STAGE.height)
  ground.addColorStop(0, theme.groundTop)
  ground.addColorStop(1, theme.groundBottom)
  context.fillStyle = ground
  context.fillRect(0, SKY.horizonY, STAGE.width, STAGE.height - SKY.horizonY)

  // Pencilled grass tufts, in fixed places so they do not shimmer.
  context.strokeStyle = 'rgba(60, 90, 50, 0.45)'
  context.lineWidth = 1
  for (let index = 0; index < 60; index++) {
    const x = SKY.left + ((index * 97) % (SKY.right - SKY.left))
    const y = SKY.horizonY + 8 + ((index * 53) % 70)
    context.beginPath()
    context.moveTo(x, y)
    context.lineTo(x - 2, y - 6)
    context.moveTo(x + 3, y)
    context.lineTo(x + 4, y - 7)
    context.stroke()
  }
}

// ---------------------------------------------------------------------------
// Containers: regions of sky, not clouds
// ---------------------------------------------------------------------------

function drawContainers(context: CanvasRenderingContext2D, model: SkyViewModel): void {
  const { scene, layout } = model
  const vpc = layout.vpc

  // Band labels at the edge of the sky, in plain words, lettered up the margin.
  // Each one is shrunk if need be so it never runs past its own band.
  const bandLabel = (text: string, top: number, bottom: number) => {
    context.save()
    context.font = `12px ${CAPTION_FONT}`
    const room = bottom - top - 8
    const size = Math.max(9, Math.min(12, (12 * room) / context.measureText(text).width))
    context.translate(SKY.left + 14, (top + bottom) / 2)
    context.rotate(-Math.PI / 2)
    caption(context, text, 0, 0, size, 'center', '#4c5878')
    context.restore()
  }
  bandLabel(BAND_LABELS.high, SKY.high.top, SKY.high.bottom)
  bandLabel(BAND_LABELS.mid, SKY.mid.top, SKY.mid.bottom)
  bandLabel(BAND_LABELS.low, SKY.low.top, SKY.low.bottom)
  caption(
    context,
    'Ground – the internet',
    SKY.right - 10,
    SKY.horizonY + 12,
    12,
    'right',
    '#3f5a36',
  )

  // The VPC: an atlas-style dashed border with a hand-lettered caption and leader line.
  context.save()
  context.strokeStyle = '#6a6578'
  context.lineWidth = 1.8
  context.setLineDash([9, 6])
  roundedRectPath(context, vpc, 14)
  context.stroke()
  context.setLineDash([])
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(vpc.x + vpc.width - 74, vpc.y - 11)
  context.lineTo(vpc.x + vpc.width - 48, vpc.y)
  context.stroke()
  context.restore()
  // The address range can be clicked to learn what the /16 means: dotted underline and an "i".
  const cidrText = `VPC ${scene.vpc.cidr}`
  const cidrRect = cidrLabelRect()
  const cidrRight = cidrRect.x + cidrRect.width - 18
  caption(context, cidrText, cidrRight, vpc.y - 14, 13, 'right')
  context.save()
  context.font = `13px ${CAPTION_FONT}`
  const cidrWidth = context.measureText(cidrText).width
  context.strokeStyle = 'rgba(61, 58, 72, 0.6)'
  context.lineWidth = 1
  context.setLineDash([2, 2])
  context.beginPath()
  context.moveTo(cidrRight - cidrWidth, vpc.y - 5)
  context.lineTo(cidrRight, vpc.y - 5)
  context.stroke()
  context.setLineDash([])
  context.beginPath()
  context.arc(cidrRight + 10, vpc.y - 14, 6.5, 0, Math.PI * 2)
  context.fillStyle = 'rgba(246, 239, 220, 0.95)'
  context.fill()
  context.stroke()
  context.restore()
  caption(context, 'i', cidrRight + 10, vpc.y - 14, 11, 'center')

  // Availability Zones: two columns separated by a faint dotted line.
  context.save()
  context.strokeStyle = 'rgba(90, 86, 104, 0.45)'
  context.setLineDash([2, 5])
  context.beginPath()
  context.moveTo(vpc.x + vpc.width / 2, vpc.y + 8)
  context.lineTo(vpc.x + vpc.width / 2, vpc.y + vpc.height - 8)
  context.stroke()
  context.restore()
  caption(context, 'Availability Zone a', vpc.x + vpc.width * 0.25, vpc.y, 11)
  caption(context, 'Availability Zone b', vpc.x + vpc.width * 0.75, vpc.y, 11)

  for (const subnet of scene.subnets) {
    const rect = layout.subnets[subnet.id]
    if (!rect) continue
    // Public and private subnets are tinted differently. "Public" follows the route
    // table, so a low-band subnet takes the public tint the moment its route is added.
    const isPublic = isPublicSubnet(scene, subnet)
    context.save()
    context.fillStyle = isPublic ? SUBNET_TINT.public : SUBNET_TINT.private
    roundedRectPath(context, rect, 9)
    context.fill()
    // The NACL: a ribbon on the boundary of the subnet cell it guards.
    context.strokeStyle = 'rgba(166, 112, 44, 0.55)'
    context.lineWidth = 2
    context.setLineDash([12, 3, 2, 3])
    context.stroke()
    context.restore()

    caption(context, subnet.name, rect.x + 8, rect.y + 10, 11, 'left', '#57536a')
    if (subnet.band === 'low') {
      // "Public" is a fact about routing, so the label follows the route table.
      caption(
        context,
        isPublic ? '✓ public: routes to the Internet Gateway' : 'not public yet: no internet route',
        rect.x + 8,
        rect.y + rect.height - 9,
        10,
        'left',
        isPublic ? '#2f6b3a' : '#8a5a2b',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Connections between clouds
// ---------------------------------------------------------------------------

function drawConnections(context: CanvasRenderingContext2D, model: SkyViewModel): void {
  const { scene, layout } = model
  context.save()
  context.lineCap = 'round'
  for (const loadBalancer of resourcesOfKind(scene, 'load-balancer')) {
    const from = layout.clouds[loadBalancer.id]
    for (const targetId of loadBalancer.targetIds) {
      const to = layout.clouds[targetId]
      if (!from || !to) continue
      // A wisp bridge: the two clouds are joined.
      const start = {
        x: Math.min(Math.max(centreOf(to).x, from.x + 30), from.x + from.width - 30),
        y: from.y + 14,
      }
      const end = { x: centreOf(to).x, y: to.y + to.height - 6 }
      for (const [width, colour] of [
        [9, 'rgba(255,255,255,0.75)'],
        [1.2, 'rgba(85,82,95,0.5)'],
      ] as const) {
        context.lineWidth = width
        context.strokeStyle = colour
        context.setLineDash(width > 2 ? [] : [3, 5])
        context.beginPath()
        context.moveTo(start.x, start.y)
        context.bezierCurveTo(start.x - 14, start.y - 20, end.x + 14, end.y + 20, end.x, end.y)
        context.stroke()
      }
    }
  }
  // A skyway: where a private subnet's route table sends S3 traffic to a gateway
  // endpoint, a road runs from the mid band straight to the bucket, never touching
  // the ground. It is drawn from the routing rules, so it appears exactly when the
  // engine would use it.
  const bucket = resourcesOfKind(scene, 's3-bucket')[0]
  const bucketRect = bucket ? layout.clouds[bucket.id] : undefined
  const viaEndpoint = scene.subnets.filter(
    (subnet) =>
      subnet.band === 'mid' && resolveRoute(scene, subnet, 's3').kind === 'gateway-endpoint',
  )
  if (bucketRect && viaEndpoint.length > 0) {
    const rects = viaEndpoint.map((subnet) => layout.subnets[subnet.id])
    const startX = Math.max(...rects.map((rect) => rect.x + rect.width))
    const y = rects[0].y + rects[0].height * 0.3
    const endX = bucketRect.x + bucketRect.width * 0.3
    context.save()
    for (const [width, colour, dash] of [
      [12, 'rgba(255,244,205,0.95)', []],
      [1.4, 'rgba(70,90,150,0.85)', [7, 5]],
    ] as const) {
      context.lineWidth = width
      context.strokeStyle = colour
      context.setLineDash([...dash])
      for (const offset of width > 2 ? [0] : [-6, 6]) {
        context.beginPath()
        context.moveTo(startX, y + offset)
        context.lineTo(endX, y + offset)
        context.stroke()
      }
    }
    context.restore()
    caption(context, 'S3 gateway endpoint', (startX + endX) / 2, y - 12, 12, 'center', '#3c4a78')
  }

  // A cirrus thread from a role down to whatever wears it.
  context.setLineDash([])
  context.lineWidth = 1.3
  context.strokeStyle = 'rgba(96, 116, 176, 0.9)'
  for (const instance of resourcesOfKind(scene, 'ec2-instance')) {
    const role = instance.roleId ? layout.clouds[instance.roleId] : undefined
    const to = layout.clouds[instance.id]
    if (!role || !to) continue
    const start = { x: centreOf(role).x, y: role.y + role.height - 6 }
    const end = { x: centreOf(to).x, y: to.y + 6 }
    context.beginPath()
    context.moveTo(start.x, start.y)
    context.bezierCurveTo(start.x + 10, start.y + 30, end.x - 20, end.y - 30, end.x, end.y)
    context.stroke()
  }
  context.restore()
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

const OUTLINE_STYLES: { colour: string; dash: number[] }[] = [
  { colour: '#3f6fb5', dash: [6, 4] },
  { colour: '#b0622f', dash: [2, 4] },
  { colour: '#3f8a52', dash: [11, 3, 2, 3] },
  { colour: '#8a4fa0', dash: [1, 3] },
]

function tintFor(resource: Resource, compromised: boolean): string[] {
  if (compromised) return [RED_TINT]
  if (resource.kind === 'ec2-instance' && !resource.healthy) return [GREY_TINT]
  const band = BAND_OF[resource.kind]
  // The S3 cloud shades through all three blues, top to bottom.
  return band === 'vertical' ? [BAND_TINT.high, BAND_TINT.mid, BAND_TINT.low] : [BAND_TINT[band]]
}

function drawPadlock(context: CanvasRenderingContext2D, x: number, y: number): void {
  context.save()
  context.strokeStyle = PENCIL
  context.fillStyle = '#e9e2cf'
  context.lineWidth = 1.3
  context.beginPath()
  context.arc(x, y - 4, 4, Math.PI, 0)
  context.stroke()
  context.beginPath()
  context.roundRect(x - 6, y - 4, 12, 9, 2)
  context.fill()
  context.stroke()
  context.restore()
}

function drawSunRays(
  context: CanvasRenderingContext2D,
  centre: Point,
  radius: number,
  strength: number,
): void {
  // Rays make the "change took effect" cue readable without relying on its gold colour.
  context.save()
  context.strokeStyle = `rgba(214, 160, 30, ${0.8 * strength})`
  context.lineWidth = 2
  context.lineCap = 'round'
  for (let ray = 0; ray < 10; ray++) {
    const angle = (ray / 10) * Math.PI * 2
    const inner = radius * 0.75
    const outer = radius * (0.95 + 0.25 * strength)
    context.beginPath()
    context.moveTo(centre.x + Math.cos(angle) * inner, centre.y + Math.sin(angle) * inner * 0.7)
    context.lineTo(centre.x + Math.cos(angle) * outer, centre.y + Math.sin(angle) * outer * 0.7)
    context.stroke()
  }
  context.restore()
}

/**
 * An Auto Scaling group: one small cloud per instance, each half of the fleet in its
 * own Availability Zone, as AWS balances them. Instances still launching are drawn
 * dashed and faint, filling in as they start; instances being removed fade away;
 * instances in a failed zone are grey and droop until they are replaced. Every instance
 * has its own place, so the fleet can be counted as it grows: 2, 4, 8, 16 (ADR 0012).
 * `slotsPerZone` is how many places each half keeps: enough for the most instances a
 * zone can hold in this level.
 */
function drawFleet(
  context: CanvasRenderingContext2D,
  rect: Rect,
  view: FleetView,
  slotsPerZone: number,
  look: { tint: string[]; sunlight: number; burst: number; opacity: number },
  time: number,
): void {
  // The fleet's outline: a soft rounded patch, so an empty-looking fleet still reads as one.
  context.save()
  context.strokeStyle = 'rgba(60, 74, 120, 0.35)'
  context.setLineDash([3, 4])
  context.lineWidth = 1.2
  roundedRectPath(context, rect, 14, 0)
  context.stroke()
  context.restore()

  const perHalf = Math.max(1, slotsPerZone)
  const halfWidth = rect.width / 2 - 8
  let best = { columns: 1, rows: perHalf, width: 0, height: 0 }
  for (let columns = 1; columns <= perHalf; columns++) {
    const rows = Math.ceil(perHalf / columns)
    const width = Math.floor(Math.min(64, (halfWidth - (columns - 1) * 6) / columns))
    const height = Math.floor(Math.min(width * 0.62, (rect.height - 10 - (rows - 1) * 4) / rows))
    if (Math.min(width, height / 0.62) > Math.min(best.width, best.height / 0.62))
      best = { columns, rows, width, height }
  }
  const { columns, rows, width, height } = best
  const gridWidth = columns * width + (columns - 1) * 6
  const gridHeight = rows * height + (rows - 1) * 4
  for (const zone of ['a', 'b'] as const) {
    const counts = view.zones[zone]
    // Serving first (those scaling in last), then failed, then launching.
    const kinds: ('serving' | 'leaving' | 'failed' | 'terminating' | 'launching')[] = [
      ...Array<'serving'>(Math.max(0, counts.serving - counts.leaving)).fill('serving'),
      ...Array<'leaving'>(counts.leaving).fill('leaving'),
      ...Array<'failed'>(Math.max(0, counts.failed - counts.terminating)).fill('failed'),
      ...Array<'terminating'>(counts.terminating).fill('terminating'),
      ...Array<'launching'>(counts.launching).fill('launching'),
    ]
    kinds.slice(0, perHalf).forEach((kind, slot) => {
      const halfLeft = zone === 'a' ? rect.x + 4 : rect.x + rect.width / 2 + 4
      const x = halfLeft + (halfWidth - gridWidth) / 2 + (slot % columns) * (width + 6)
      const y = rect.y + (rect.height - gridHeight) / 2 + Math.floor(slot / columns) * (height + 4)
      if (kind === 'launching') {
        context.save()
        context.strokeStyle = 'rgba(60, 74, 120, 0.8)'
        context.setLineDash([3, 3])
        context.lineWidth = 1.2
        roundedRectPath(context, { x, y, width, height }, 8, 0)
        context.stroke()
        context.restore()
        drawCloud(context, 'altocumulus', x, y, width, height, {
          ...look,
          opacity: look.opacity * (0.15 + 0.45 * view.launchProgress),
        })
      } else if (kind === 'failed' || kind === 'terminating') {
        // Unhealthy in a failed zone: grey and drooping, until the group replaces it.
        const droop = 4 + (time > 0 ? Math.sin(time / 700 + slot) : 0)
        drawCloud(context, 'altocumulus', x, y + droop, width, height, {
          ...look,
          tint: [GREY_TINT],
          opacity: look.opacity * (kind === 'terminating' ? 1 - view.leaveFade : 0.85),
        })
      } else {
        drawCloud(context, 'altocumulus', x, y, width, height, {
          ...look,
          opacity: look.opacity * (kind === 'leaving' ? 1 - view.leaveFade : 1),
        })
      }
    })
  }
}

/** A database copy's two-line caption, beside its cloud on the side away from the zone divider. */
function databaseCaption(
  context: CanvasRenderingContext2D,
  rect: Rect,
  zone: AvailabilityZone,
  lines: [string, string],
  colour: string,
): void {
  const side = databaseCaptionSide(zone)
  const x = side === 'left' ? rect.x - 14 : rect.x + rect.width + 14
  const align = side === 'left' ? 'right' : 'left'
  const middle = rect.y + rect.height / 2
  caption(context, lines[0], x, middle - 7, 12, align, colour)
  caption(context, lines[1], x, middle + 8, 11, align, colour)
}

/**
 * An RDS database (ADR 0014): its primary as a flat altostratus in its subnet and, with
 * Multi-AZ, its standby as a fainter one in the other zone, joined by a wisp bridge (the
 * grammar's "connected"). During a failover, lightning arcs from the failed primary to
 * the standby, which wakes up as it takes over (the grammar's "failover"). A copy in a
 * failed zone is grey and droops.
 */
function drawDatabase(
  context: CanvasRenderingContext2D,
  model: SkyViewModel,
  database: RdsDatabase,
  locked: boolean,
): void {
  const { scene, layout } = model
  const record = model.crowd
  const flying = record !== null && model.crowd !== null && crowdFrameAt(record, model.runTime)
  const view = flying && record ? databaseViewAt(record, database.id, model.runTime) : null
  const authoredZone =
    scene.subnets.find((subnet) => subnet.id === database.primarySubnetId)?.availabilityZone ?? 'a'
  const otherZone: AvailabilityZone = authoredZone === 'a' ? 'b' : 'a'
  const primaryZone = view?.primaryZone ?? authoredZone
  const standbyZone = view ? view.standbyZone : database.multiAz ? otherZone : null
  const lostZone = view?.lostZone ?? null
  const down = outageZones(model)
  const bob = model.reducedMotion ? 0 : Math.sin(model.time / 900 + 3) * 1.5
  const look = { tint: [BAND_TINT.mid], sunlight: 0, burst: 0, opacity: locked ? 0.62 : 1 }
  const primary = databaseRect(scene, layout, database, primaryZone)
  const standby = standbyZone ? databaseRect(scene, layout, database, standbyZone) : null
  const lost =
    lostZone && lostZone !== primaryZone ? databaseRect(scene, layout, database, lostZone) : null
  const failingOver = view?.status === 'failing-over'
  const waking = failingOver ? (view?.failover ?? 0) : 0

  // The wisp bridge between primary and standby: they are kept in step.
  if (primary && standby && !failingOver) {
    drawWispBridge(context, centreOf(primary), centreOf(standby), model.time, model.reducedMotion)
  }

  // A copy that was lost with its zone: grey and drooping.
  if (lost) {
    drawCloud(context, 'altostratus', lost.x, lost.y + 6, lost.width, lost.height, {
      ...look,
      tint: [GREY_TINT],
    })
    databaseCaption(
      context,
      lost,
      lostZone!,
      ['lost with', `AZ ${lostZone!.toUpperCase()}`],
      '#57536a',
    )
  }

  if (standby) {
    // During a failover the standby wakes: from faint to solid as it takes over.
    drawCloud(context, 'altostratus', standby.x, standby.y + bob, standby.width, standby.height, {
      ...look,
      opacity: look.opacity * (0.42 + 0.58 * waking),
    })
    databaseCaption(
      context,
      standby,
      standbyZone!,
      failingOver ? ['standby:', 'taking over…'] : ['standby', '(Multi-AZ)'],
      failingOver ? '#7a5a12' : '#3c4a78',
    )
  }

  if (primary) {
    const primaryDown =
      view?.status === 'unavailable' || failingOver || (down.includes(primaryZone) && !view)
    const y = primary.y + (primaryDown ? 6 : bob)
    drawCloud(context, 'altostratus', primary.x, y, primary.width, primary.height, {
      ...look,
      tint: primaryDown ? [GREY_TINT] : look.tint,
    })
    // Its security group's pencilled outline goes where the primary is.
    database.securityGroupIds.forEach((groupId: string, layer: number) => {
      const style =
        OUTLINE_STYLES[
          scene.securityGroups.findIndex((group) => group.id === groupId) % OUTLINE_STYLES.length
        ]
      if (!style) return
      context.save()
      context.strokeStyle = style.colour
      context.lineWidth = 1.7
      context.setLineDash(style.dash)
      roundedRectPath(context, { ...primary, y }, 14, 6 + layer * 5)
      context.stroke()
      context.restore()
    })
    const state =
      view?.status === 'unavailable'
        ? 'down'
        : failingOver
          ? 'failing over'
          : database.multiAz || standbyZone
            ? 'primary'
            : 'single-AZ'
    databaseCaption(
      context,
      { ...primary, y },
      primaryZone,
      [database.name, state],
      primaryDown ? '#9b2c22' : PENCIL,
    )
    if (locked) drawPadlock(context, primary.x + primary.width - 2, y + 4)
  }

  // Failover: lightning arcs between the clouds, from the failed primary to the standby.
  if (failingOver && primary && standby && !model.reducedMotion) {
    const flicker = Math.sin(model.time / 37) > -0.2
    if (flicker) drawLightning(context, centreOf(primary), centreOf(standby), model.time, 0.9)
  }
}

/** A wisp bridge: a soft, slightly wavy band joining two clouds that are connected. */
function drawWispBridge(
  context: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  time: number,
  still: boolean,
): void {
  context.save()
  context.strokeStyle = 'rgba(255, 255, 255, 0.75)'
  context.lineCap = 'round'
  for (let strand = 0; strand < 3; strand++) {
    const wave = still ? 0 : Math.sin(time / 800 + strand * 2) * 4
    context.lineWidth = 4 - strand
    context.beginPath()
    context.moveTo(from.x, from.y + strand * 3)
    context.quadraticCurveTo(
      (from.x + to.x) / 2,
      (from.y + to.y) / 2 - 16 + wave + strand * 4,
      to.x,
      to.y + strand * 3,
    )
    context.stroke()
  }
  context.restore()
}

/** A jagged lightning bolt from one point to another, with a soft glow. Deterministic. */
function drawLightning(
  context: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  time: number,
  strength: number,
): void {
  const steps = 9
  const points: Point[] = [from]
  const seed = Math.floor(time / 90)
  for (let step = 1; step < steps; step++) {
    const along = step / steps
    const jitter = Math.sin(seed * 12.9898 + step * 78.233) * 43758.5453
    const offset = (jitter - Math.floor(jitter) - 0.5) * 26
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy) || 1
    points.push({
      x: from.x + dx * along + (-dy / length) * offset,
      y: from.y + dy * along + (dx / length) * offset,
    })
  }
  points.push(to)
  context.save()
  context.lineJoin = 'round'
  for (const [width, colour] of [
    [9, `rgba(255, 244, 170, ${0.35 * strength})`],
    [3.2, `rgba(255, 250, 220, ${strength})`],
  ] as const) {
    context.strokeStyle = colour
    context.lineWidth = width
    context.beginPath()
    points.forEach((point, index) =>
      index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y),
    )
    context.stroke()
  }
  context.restore()
}

/** The zones down at this moment of a crowd run; none outside a run. */
function outageZones(model: SkyViewModel): AvailabilityZone[] {
  return model.crowd && crowdFrameAt(model.crowd, model.runTime)
    ? outageAt(model.crowd, model.runTime).zones
    : []
}

/**
 * An Availability Zone failing (ADR 0014): lightning strikes the ground over its column
 * as it fails, and while it is down the column is washed grey, its clouds greyed, with
 * a caption in words. The grammar's "outage or AZ failure".
 */
function drawOutage(context: CanvasRenderingContext2D, model: SkyViewModel): void {
  if (!model.crowd || !crowdFrameAt(model.crowd, model.runTime)) return
  const { zones, strike, struck } = outageAt(model.crowd, model.runTime)
  for (const zone of zones) {
    const cells = model.scene.subnets
      .filter((subnet) => subnet.availabilityZone === zone)
      .map((subnet) => model.layout.subnets[subnet.id])
      .filter((rect): rect is Rect => rect !== undefined)
    if (cells.length === 0) continue
    const left = Math.min(...cells.map((rect) => rect.x))
    const right = Math.max(...cells.map((rect) => rect.x + rect.width))
    const top = Math.min(...cells.map((rect) => rect.y))
    const bottom = Math.max(...cells.map((rect) => rect.y + rect.height))
    context.save()
    context.fillStyle = 'rgba(96, 98, 112, 0.36)'
    context.fillRect(left, top, right - left, bottom - top)
    context.restore()
    // Above the VPC, over its column, where it does not cover the clouds it is about.
    caption(
      context,
      `⚡ Availability Zone ${zone} is down`,
      (left + right) / 2,
      model.layout.vpc.y - 20,
      14,
      'center',
      '#2b2b38',
    )
    if (struck.includes(zone) && strike > 0 && !model.reducedMotion) {
      // Cloud to ground: from the sky above the column down to the ground.
      const x = (left + right) / 2
      drawLightning(
        context,
        { x: x - 30, y: SKY.high.top },
        { x: x + 20, y: SKY.groundY - 40 },
        model.time,
        strike,
      )
      drawLightning(
        context,
        { x: x + 40, y: top },
        { x: x - 50, y: SKY.groundY - 60 },
        model.time + 300,
        strike * 0.7,
      )
      context.save()
      context.fillStyle = `rgba(255, 255, 240, ${0.22 * strike})`
      context.fillRect(SKY.left, 0, SKY.right - SKY.left, SKY.groundY)
      context.restore()
    }
  }
}

function drawClouds(
  context: CanvasRenderingContext2D,
  model: SkyViewModel,
  burstFor: Record<string, number>,
  crowdFrame: CrowdFrame | null,
): void {
  const { scene, layout, time } = model
  for (const resource of scene.resources) {
    const rect = layout.clouds[resource.id]
    if (!rect) continue
    const locked = model.lockedIds.includes(resource.id)
    if (resource.kind === 'rds-database') {
      drawDatabase(context, model, resource, locked)
      continue
    }
    const compromised = model.compromisedIds.includes(resource.id)
    const unhealthy = resource.kind === 'ec2-instance' && !resource.healthy
    const bob = model.reducedMotion ? 0 : Math.sin(time / 900 + rect.x * 0.05) * 1.5
    const y = rect.y + bob + (unhealthy ? 6 : 0)

    const started = model.sunlightStartedAt[resource.id]
    const age = started === undefined ? Infinity : time - started
    const sunlight = age < SUNLIGHT_DURATION ? Math.sin((age / SUNLIGHT_DURATION) * Math.PI) : 0
    if (sunlight > 0)
      drawSunRays(context, centreOf(rect), Math.max(rect.width, rect.height) * 0.62, sunlight)

    context.save()
    if (compromised) {
      // Dark, smoky edges, so "compromised" does not depend on the red tint alone.
      context.shadowColor = 'rgba(40, 18, 18, 0.9)'
      context.shadowBlur = 16
    }
    const look = {
      tint: tintFor(resource, compromised),
      sunlight,
      burst: burstFor[resource.id] ?? 0,
      opacity: locked ? 0.62 : 1,
    }
    if (resource.kind === 'auto-scaling-group') {
      // A fleet is a patch of clouds, one per instance, that grows and shrinks. During a
      // crowd run the engine's record says how many are serving, launching and leaving.
      const zones = resource.subnetIds.map(
        (id) => scene.subnets.find((subnet) => subnet.id === id)?.availabilityZone ?? 'a',
      )
      const view = (crowdFrame && model.crowd
        ? fleetViewAt(model.crowd, resource.id, model.runTime)
        : null) ?? {
        serving: runningCount(resource),
        launching: 0,
        launchProgress: 0,
        leaving: 0,
        leaveFade: 0,
        attached: isAttached(scene, resource.id),
        zones: restingZones(resource, scene),
      }
      // Each half keeps room for its share of the maximum; in a level with a storm, for
      // the whole maximum, since every instance may end up in the zone that is left.
      const storm = model.level.events.some((event) => event.kind === 'az-failure')
      const slots = storm ? resource.max : Math.ceil(resource.max / Math.max(1, zones.length))
      drawFleet(context, { ...rect, y }, view, slots, look, model.reducedMotion ? 0 : time)
    } else {
      drawCloud(context, GENUS_OF[resource.kind], rect.x, y, rect.width, rect.height, look)
    }
    context.restore()

    // Security groups: a pencilled outline traced around each cloud that wears one.
    if ('securityGroupIds' in resource) {
      resource.securityGroupIds.forEach((groupId, layer) => {
        const style =
          OUTLINE_STYLES[
            scene.securityGroups.findIndex((group) => group.id === groupId) % OUTLINE_STYLES.length
          ]
        if (!style) return
        context.save()
        context.strokeStyle = style.colour
        context.lineWidth = 1.7
        context.setLineDash(style.dash)
        roundedRectPath(context, { ...rect, y }, 18, 6 + layer * 5)
        context.stroke()
        context.restore()
      })
    }

    const labelY =
      resource.kind === 's3-bucket'
        ? rect.y + rect.height + 12
        : y + rect.height + ('securityGroupIds' in resource ? 16 : 10)
    if (resource.kind === 'auto-scaling-group') {
      // The fleet's name and what it is doing, one line, so it stays in the mid band.
      const view =
        crowdFrame && model.crowd ? fleetViewAt(model.crowd, resource.id, model.runTime) : null
      const policy = resource.scaling
        ? `CPU target ${resource.scaling.targetCpuPercent}%`
        : 'no scaling policy'
      const status = view
        ? `${view.serving - view.leaving} ${resource.size} serving${view.launching > 0 ? ` · ${view.launching} launching` : ''}${view.leaving > 0 ? ` · ${view.leaving} leaving` : ''}`
        : `${resource.min}–${resource.max} instances · ${policy}`
      caption(context, `${resource.name} · ${status}`, centreOf(rect).x, y + rect.height + 9, 12)
      if (!isAttached(scene, resource.id)) {
        caption(
          context,
          'no load balancer sends it kites',
          centreOf(rect).x,
          y + rect.height + 22,
          11,
          'center',
          '#8a4b12',
        )
      }
    } else {
      caption(context, resource.name, centreOf(rect).x, labelY, 12)
    }
    if (compromised)
      caption(context, '⚡ compromised', centreOf(rect).x, labelY + 14, 11, 'center', '#8c1f1f')
    if (locked) drawPadlock(context, rect.x + rect.width - 2, y + 4)

    if (model.editable && !locked && canStartConnection(resource.kind)) {
      const handle = handlePosition({ ...rect, y })
      context.save()
      context.fillStyle = '#fffdf5'
      context.strokeStyle = PENCIL
      context.lineWidth = 1.5
      context.beginPath()
      context.arc(handle.x, handle.y, 7, 0, Math.PI * 2)
      context.fill()
      context.stroke()
      context.beginPath()
      context.moveTo(handle.x - 3, handle.y)
      context.lineTo(handle.x + 3, handle.y)
      context.moveTo(handle.x, handle.y - 3)
      context.lineTo(handle.x, handle.y + 3)
      context.stroke()
      context.restore()
    }
  }
}

function drawHighlight(context: CanvasRenderingContext2D, model: SkyViewModel): void {
  for (const highlight of model.highlights) {
    const [kind, id] = highlight.split(':')
    const rect =
      kind === 'resource'
        ? model.layout.clouds[id ?? '']
        : kind === 'subnet'
          ? model.layout.subnets[id ?? '']
          : undefined
    if (!rect) continue
    const pulse = model.reducedMotion ? 0 : Math.sin(model.time / 260) * 3
    context.save()
    context.strokeStyle = '#c86a1c'
    context.lineWidth = 3
    context.setLineDash([10, 6])
    roundedRectPath(context, rect, 20, 12 + pulse)
    context.stroke()
    context.restore()
  }
}

// ---------------------------------------------------------------------------
// Cloudlings, kites and what happens to them
// ---------------------------------------------------------------------------

/**
 * What a check mark says: a pass, a fault the player should fix, or a red kite blocked
 * by a defence that is doing its job.
 */
type MarkKind = 'pass' | 'fail' | 'blocked'

function marker(
  context: CanvasRenderingContext2D,
  at: Point,
  kind: MarkKind,
  label?: string,
): void {
  // Shape as well as colour: a round tick for a pass, a square cross for a fault, a
  // shield for a red kite turned away. Only faults are red (ADR 0009).
  context.save()
  context.lineWidth = 1.6
  context.strokeStyle = '#ffffff'
  context.fillStyle = kind === 'fail' ? '#b3342c' : '#3c8a4a'
  context.beginPath()
  if (kind === 'pass') context.arc(at.x, at.y, 6, 0, Math.PI * 2)
  else if (kind === 'fail') context.rect(at.x - 7, at.y - 7, 14, 14)
  else {
    context.moveTo(at.x - 7, at.y - 7)
    context.lineTo(at.x + 7, at.y - 7)
    context.lineTo(at.x + 7, at.y)
    context.quadraticCurveTo(at.x + 6, at.y + 6, at.x, at.y + 9)
    context.quadraticCurveTo(at.x - 6, at.y + 6, at.x - 7, at.y)
    context.closePath()
  }
  context.fill()
  if (kind === 'blocked') context.stroke()
  context.beginPath()
  if (kind === 'fail') {
    context.moveTo(at.x - 3.5, at.y - 3.5)
    context.lineTo(at.x + 3.5, at.y + 3.5)
    context.moveTo(at.x + 3.5, at.y - 3.5)
    context.lineTo(at.x - 3.5, at.y + 3.5)
  } else {
    context.moveTo(at.x - 3, at.y)
    context.lineTo(at.x - 1, at.y + 2.5)
    context.lineTo(at.x + 3.5, at.y - 2.5)
  }
  context.stroke()
  context.restore()
  if (!label) return
  // A blocked red kite's label goes to the left, so it never sits on top of a green
  // kite's label at the same cloud.
  if (kind === 'blocked') caption(context, label, at.x - 12, at.y - 12, 12, 'right', '#255c31')
  else
    caption(
      context,
      label,
      at.x + 12,
      at.y - 12,
      12,
      'left',
      kind === 'fail' ? '#8c1f1f' : '#255c31',
    )
}

function drawRain(context: CanvasRenderingContext2D, at: Point, time: number, fade = 1): void {
  context.save()
  context.strokeStyle = `rgba(62, 110, 178, ${0.9 * fade})`
  context.lineWidth = 2
  context.lineCap = 'round'
  for (let drop = 0; drop < 5; drop++) {
    const dx = (drop - 2) * 5
    const dy = ((time / 14 + drop * 7) % 14) - 7
    context.beginPath()
    context.moveTo(at.x + dx, at.y + dy)
    context.lineTo(at.x + dx - 1.5, at.y + dy + 6)
    context.stroke()
  }
  context.restore()
}

/** The block animations: each control stops a kite with its own object. */
function blockOffset(stoppedBy: CheckKind | undefined, progress: number): Point {
  const early = Math.min(1, progress / 0.45)
  switch (stoppedBy) {
    case 'security-group': // bumps the outline and bounces off
      return { x: 0, y: Math.abs(Math.sin(early * Math.PI * 2.5)) * 16 }
    case 'route': // drifts along the border, finding no gate
      return { x: early * 70, y: Math.sin(early * Math.PI * 3) * 3 }
    case 'block-public-access': // slides off the shell
      return { x: -early * 26, y: early * 30 }
    case 'nacl': // tangled in the ribbon (the kite itself wobbles)
      return { x: Math.sin(early * Math.PI * 6) * 4, y: 0 }
    default: // timed out: the string goes slack and the kite drifts down
      return { x: 0, y: early * 18 }
  }
}

function drawKiteAndCloudling(
  context: CanvasRenderingContext2D,
  model: SkyViewModel,
  kite: Kite,
  script: KiteScript | undefined,
  costume: string,
): void {
  const hostile = kite.kind === 'hostile'
  const frame: KiteFrame | undefined = script ? frameAt(script, model.runTime) : undefined
  const finished = frame?.phase === 'ending' || frame?.phase === 'done'
  const ending = finished ? script?.ending : undefined

  let mood: Mood = 'idle'
  if (ending === 'delivered') mood = frame?.phase === 'ending' ? 'cheer' : 'idle'
  if (ending === 'failed') mood = 'droop'
  if (ending === 'foiled') mood = frame?.phase === 'ending' ? 'stamp' : 'idle'
  if (ending === 'breach') mood = 'snicker'

  const feet = script?.cloudling ?? { x: 290 + kite.groundPosition * 112, y: SKY.groundY }
  const hand = drawCloudling(
    context,
    feet.x,
    feet.y,
    hostile,
    model.reducedMotion && mood === 'cheer' ? 'idle' : mood,
    costume,
    model.time,
  )
  const rest = script?.rest ?? { x: feet.x + 22, y: feet.y - 92 }
  if (!frame || !script || frame.phase === 'waiting') {
    drawString(context, hand, rest, 0, model.time)
    drawKite(context, rest.x, rest.y, hostile, 'flying', model.reducedMotion ? 0 : model.time)
    return
  }

  const stopPoint = frame.position
  const progress = frame.endingProgress
  const late = Math.max(0, (progress - 0.45) / 0.55) // the aftermath part of the ending
  const lerp = (from: Point, to: Point, amount: number): Point => ({
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  })

  // Markers for the checks reached so far. While flying, the newest carries its name.
  const selected = model.selectedKiteId === kite.id
  script.beats.forEach((beat, index) => {
    if (index > frame.reached) return
    const newest = index === frame.reached && frame.phase === 'flying'
    const failed = beat.step.result === 'fail'
    if (!(newest || failed || selected || model.reducedMotion)) return
    const jitter = {
      x: beat.position.x + ((index % 3) - 1) * 9,
      y: beat.position.y + (((index * 2) % 3) - 1) * 9,
    }
    // A red kite stopped by a check is a defence working: no red cross on a cloud that
    // is configured correctly.
    const kind: MarkKind = !failed ? 'pass' : hostile ? 'blocked' : 'fail'
    const label =
      newest || failed
        ? `${CHECK_LABELS[beat.step.check]}${kind === 'blocked' ? ': blocked' : ''}`
        : selected
          ? String(index + 1)
          : undefined
    marker(context, jitter, kind, label)
  })

  if (frame.phase === 'flying') {
    drawString(context, hand, frame.kitePosition, 0, model.time)
    if (frame.carrier === 'kite')
      drawKite(context, frame.position.x, frame.position.y, hostile, 'flying', model.time)
    else drawRain(context, frame.position, model.time)
    return
  }

  switch (ending) {
    case 'delivered': {
      // The kite has vanished into the cloud; a short column of rain falls on its Cloudling.
      if (progress < 1 && !model.reducedMotion) {
        for (let row = 0; row < 4; row++)
          drawRain(
            context,
            { x: feet.x, y: feet.y - 150 + row * 22 + late * 20 },
            model.time + row * 40,
            1 - progress * 0.6,
          )
      }
      break
    }
    case 'breach': {
      // The string stays attached, and stolen raindrops trickle down it to the attacker.
      drawString(context, hand, frame.kitePosition, 0, model.time)
      const trickle = model.reducedMotion ? 0.5 : (model.time / 1600) % 1
      const drop = lerp(frame.kitePosition, hand, trickle)
      context.save()
      context.fillStyle = '#3e6eb2'
      context.beginPath()
      context.arc(drop.x + 8, drop.y + 6, 3, 0, Math.PI * 2)
      context.fill()
      context.restore()
      break
    }
    case 'failed':
    case 'foiled': {
      const offset = blockOffset(script.stoppedBy, progress)
      const bumped = { x: frame.kitePosition.x + offset.x, y: frame.kitePosition.y + offset.y }
      const rainStopped = frame.carrier === 'rain'
      if (rainStopped && progress < 0.6) {
        // Rain evaporating at the resource: puffs rise and fade.
        context.save()
        context.strokeStyle = `rgba(90, 100, 130, ${0.8 - progress})`
        for (let puff = 0; puff < 3; puff++) {
          context.beginPath()
          context.arc(
            stopPoint.x + (puff - 1) * 9,
            stopPoint.y - progress * 40 - puff * 5,
            4 + progress * 8,
            0,
            Math.PI * 2,
          )
          context.stroke()
        }
        context.restore()
      }
      if (script.stoppedBy === 'block-public-access' && progress < 0.9) {
        // A pale shell closes over the bucket.
        const bucket = model.layout.clouds[kite.destinationId]
        if (bucket) {
          context.save()
          context.fillStyle = `rgba(250, 250, 240, ${0.5 * (1 - progress)})`
          context.strokeStyle = `rgba(120, 116, 130, ${1 - progress})`
          context.lineWidth = 2
          context.beginPath()
          context.ellipse(
            centreOf(bucket).x,
            centreOf(bucket).y,
            bucket.width * 0.62,
            bucket.height * 0.56,
            0,
            0,
            Math.PI * 2,
          )
          context.fill()
          context.stroke()
          context.restore()
        }
      }
      if (ending === 'foiled') {
        // A stopped hostile kite is a success: it crumples and drops to the ground.
        const ground = { x: feet.x + 30, y: feet.y - 6 }
        const position = lerp(bumped, ground, late)
        if (late < 1) drawString(context, hand, position, late, model.time)
        drawKite(
          context,
          position.x,
          position.y,
          hostile,
          late > 0.15 ? 'crumpled' : script.stoppedBy === 'nacl' ? 'tangled' : 'flying',
          model.time,
        )
      } else {
        // A stopped friendly kite is the player's misconfiguration: it sags back to its Cloudling.
        const position = lerp(bumped, { x: rest.x, y: rest.y + 26 }, late)
        drawString(context, hand, position, 0.4 + late * 0.4, model.time)
        drawKite(
          context,
          position.x,
          position.y,
          hostile,
          script.stoppedBy === 'nacl' && late === 0 ? 'tangled' : 'flying',
          model.reducedMotion ? 0 : model.time,
          1 - late * 0.1,
        )
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Crowds and the weather station
// ---------------------------------------------------------------------------

/**
 * A crowd run, one minute at a time (ADRs 0012 and 0013). Each Cloudling keeps one kite
 * up while it stays, on a long string all the way to the load balancer, as kites reach
 * their cloud in every other level. A kite with room stays attached there, and data
 * rains back on its Cloudling now and then. A kite with no room is knocked loose, falls
 * to the ground beside its Cloudling and lies there until there is room, then rises and
 * attaches again; its Cloudling droops meanwhile. Newcomers walk on and send their kites
 * up; leavers reel theirs in and walk off. Who gets which fate comes from the engine's
 * counts (crowdPlayback.ts); nothing is decided here.
 */
function drawCrowd(context: CanvasRenderingContext2D, model: SkyViewModel, costume: string): void {
  const record = model.crowd
  const crowd = model.level.crowd
  if (!record || !crowd) return
  const biggest = Math.max(0, ...record.ticks.map((tick) => tick.demand))
  const spots = crowdSpots(model.level.population, biggest)
  const lerp = (from: Point, to: Point, amount: number): Point => ({
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  })
  // Where the kites go up to: the underside of the load balancer, or, if the crowd is
  // stopped before it, the place it is stopped.
  const frame = crowdFrameAt(record, model.runTime)
  const balancer = model.layout.clouds[crowd.loadBalancerId]
  const stream = frame
    ? crowdStream(frame.tick, model.scene, model.layout, { x: 558, y: SKY.groundY - 102 })
    : null
  const attachTo = (member: number): Point => {
    // Spread the kites out so they overlap as little as they can: two staggered rows.
    const across = (member * 0.618034) % 1
    const row = member % 2
    if (stream?.stoppedAt || !balancer) {
      const at = stream?.stoppedAt ?? { x: 558, y: SKY.groundY - 160 }
      return { x: at.x - 60 + across * 120, y: at.y + 14 + row * 12 }
    }
    // Tucked into the cloud's underside, clear of its name below.
    return {
      x: balancer.x + 14 + across * (balancer.width - 28),
      y: balancer.y + balancer.height - 22 + row * 10,
    }
  }
  const members = Array.from({ length: Math.min(biggest, spots.length) }, (_, member) => member)
    .map((member) => ({
      member,
      view: memberViewAt(record, member, spots[member]!, model.runTime),
    }))
    .filter((entry) => entry.view !== null)
    // The back row first, so the front row stands in front of it.
    .sort((first, second) => first.view!.feet.y - second.view!.feet.y)

  // Each Cloudling and its string, back row first; then every kite on top, so no string
  // or Cloudling hides a kite.
  const placed = members.map(({ member, view }) => {
    const feet = view!.feet
    const inHand = { x: feet.x + 12, y: feet.y - 30 }
    const sway = model.reducedMotion ? 0 : Math.sin(model.time / 900 + member) * 1.5
    const attached = attachTo(member)
    const up = { x: attached.x + sway, y: attached.y }
    const fallen = { x: feet.x + 24, y: feet.y - 6 }
    const at = lerp(lerp(inHand, up, view!.aloft), fallen, view!.sag)
    return { member, view: view!, at }
  })
  for (const { member, view, at } of placed) {
    context.save()
    context.globalAlpha = view.opacity
    const mood: Mood = view.sag > 0.5 ? 'droop' : 'idle'
    const hand = drawCloudling(context, view.feet.x, view.feet.y, false, mood, costume, model.time)
    // A long string, taut while the kite is attached, slack once it has fallen.
    drawString(context, hand, at, view.sag * 0.6, model.reducedMotion ? 0 : model.time)
    // Attached kites rain data back on their Cloudlings now and then, each in its turn.
    if (view.fate === 'delivered' && view.aloft >= 1 && view.sag < 0.05 && !model.reducedMotion) {
      const phase = (model.runTime + member * 431) % 3200
      if (phase < 900)
        drawRain(
          context,
          { x: view.feet.x + 6, y: view.feet.y - 62 + (phase / 900) * 18 },
          model.time,
          1 - phase / 900,
        )
    }
    context.restore()
  }
  for (const { view, at } of placed) {
    context.save()
    context.globalAlpha = view.opacity
    drawKite(context, at.x, at.y, false, 'flying', model.reducedMotion ? 0 : model.time, 0.6)
    context.restore()
  }
}

/**
 * Where the load balancer sends the crowd's kites on to: dots from it to each cloud
 * serving kites, in proportion to its room, so a fleet nobody sends kites to gets none.
 * (The kites' own strings show the way up to it.) Where there is no room, a note at
 * the load balancer says how many timed out; where the crowd is stopped, a note says where.
 */
function drawCrowdStream(
  context: CanvasRenderingContext2D,
  model: SkyViewModel,
  frame: CrowdFrame,
): void {
  const origin = { x: (SKY.left + WEATHER_STATION.x) / 2, y: SKY.groundY - 102 }
  const stream = crowdStream(frame.tick, model.scene, model.layout, origin)
  const seconds = model.reducedMotion ? 0 : model.runTime / 1000
  const dots = (path: Point[], count: number, colour: string) => {
    if (path.length < 2 || count <= 0) return
    const length = path.slice(1).reduce((sum, point, index) => {
      const from = path[index]!
      return sum + Math.hypot(point.x - from.x, point.y - from.y)
    }, 0)
    context.save()
    context.fillStyle = colour
    for (let dot = 0; dot < count; dot++) {
      const amount = ((((seconds * 55) / Math.max(1, length) + dot / count) % 1) + 1) % 1
      const point = alongPath(path, amount)
      context.globalAlpha = Math.min(1, amount * 6, (1 - amount) * 6) * 0.8
      context.beginPath()
      context.arc(point.x, point.y, 2.6, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }
  const tick = frame.tick
  // The kites' strings show the way up to the load balancer; dots show where it sends
  // them on, and on again to the database if the application reads one. Blue dots get
  // an answer; red ones are turned away where they stop; grey ones get no answer.
  const hub = stream.trunk.at(-1)
  if (hub) {
    const served = Math.min(tick.demand, tick.capacity)
    const turnedAway: Point[] = []
    for (const branch of stream.branches) {
      const count = Math.max(1, Math.round((branch.share * served) / 2))
      const colour =
        branch.outcome === 'delivered'
          ? '#2f6fb3'
          : branch.outcome === 'blocked'
            ? '#b5443a'
            : '#8a8a96'
      dots([hub, branch.to], count, colour)
      if (branch.database) {
        dots([branch.to, branch.database], count, colour)
        if (branch.outcome === 'blocked') turnedAway.push(branch.database)
      }
    }
    const noRoom = tick.capacity > 0 ? Math.max(0, tick.demand - tick.capacity) : 0
    if (noRoom > 0) {
      caption(
        context,
        `no room for ${noRoom} kite${noRoom === 1 ? '' : 's'}`,
        hub.x + 96,
        hub.y - 6,
        12,
        'left',
        '#9b2c22',
      )
    }
    const at = turnedAway[0]
    if (at) {
      caption(context, '✕ turned away here', at.x + 70, at.y - 4, 12, 'left', '#9b2c22')
    }
  }
  if (stream.databaseNote) {
    const { at, label } = stream.databaseNote
    caption(context, label, at.x, at.y, 12, 'center', '#9b2c22')
  }
  if (stream.stoppedAt) {
    caption(
      context,
      stream.stoppedLabel,
      stream.stoppedAt.x + 14,
      stream.stoppedAt.y,
      12,
      'left',
      '#9b2c22',
    )
  }
}

/**
 * CloudWatch, as a weather station on the ground at the right: a dial for the CPU of
 * the load balancer's targets, with the scaling policy's target marked on it; a bell
 * that rings when an alarm goes into ALARM; an anemometer that spins faster as more
 * kites fly; and a readout of the minute, the CPU and the room. Shown in crowd levels.
 */
function drawWeatherStation(
  context: CanvasRenderingContext2D,
  model: SkyViewModel,
  frame: CrowdFrame | null,
): void {
  const { x, y } = WEATHER_STATION
  const tick = frame?.tick
  const record = model.crowd
  const policyGroup = resourcesOfKind(model.scene, 'auto-scaling-group').find(
    (group) => group.scaling !== null,
  )
  const target = policyGroup?.scaling?.targetCpuPercent
  // A group nobody sends kites to runs at 0%, whatever the dial shows for the targets.
  const policyIdle = policyGroup !== undefined && !isAttached(model.scene, policyGroup.id)
  context.save()
  context.strokeStyle = PENCIL
  context.lineCap = 'round'
  context.lineWidth = 2

  // Post and tripod feet.
  context.beginPath()
  context.moveTo(x, y)
  context.lineTo(x, y - 116)
  context.moveTo(x - 12, y)
  context.lineTo(x, y - 16)
  context.lineTo(x + 12, y)
  context.stroke()

  // Anemometer at the top: three cups, spinning with the number of kites in the air.
  const spin =
    model.reducedMotion || !tick || (frame?.progress ?? 1) >= 1
      ? 0.4
      : (model.time / 1000) * (0.6 + tick.demand / 10)
  context.lineWidth = 1.4
  for (let arm = 0; arm < 3; arm++) {
    const angle = spin + (arm * Math.PI * 2) / 3
    const cup = { x: x + Math.cos(angle) * 14, y: y - 120 + Math.sin(angle) * 4 }
    context.beginPath()
    context.moveTo(x, y - 120)
    context.lineTo(cup.x, cup.y)
    context.stroke()
    context.beginPath()
    context.arc(cup.x, cup.y, 3, 0, Math.PI * 2)
    context.fillStyle = '#e9e2cf'
    context.fill()
    context.stroke()
  }

  // The dial: CPU from 0% (lower left) round to 100% (lower right).
  const dial = { x, y: y - 70, r: 24 }
  const angleOf = (percent: number) => Math.PI * 0.75 + (percent / 100) * Math.PI * 1.5
  context.beginPath()
  context.arc(dial.x, dial.y, dial.r, 0, Math.PI * 2)
  context.fillStyle = '#fffdf5'
  context.fill()
  context.lineWidth = 2
  context.stroke()
  // Scale: green while there is headroom, amber above the target, red near full.
  const band = (from: number, to: number, colour: string) => {
    context.beginPath()
    context.arc(dial.x, dial.y, dial.r - 4, angleOf(from), angleOf(to))
    context.strokeStyle = colour
    context.lineWidth = 4
    context.stroke()
  }
  band(0, target ?? 70, '#7fb685')
  band(target ?? 70, 90, '#e0b54a')
  band(90, 100, '#c4553f')
  if (target !== undefined) {
    // The policy's target, as a pencil tick across the scale.
    const angle = angleOf(target)
    context.beginPath()
    context.moveTo(dial.x + Math.cos(angle) * (dial.r - 9), dial.y + Math.sin(angle) * (dial.r - 9))
    context.lineTo(dial.x + Math.cos(angle) * (dial.r + 3), dial.y + Math.sin(angle) * (dial.r + 3))
    context.strokeStyle = PENCIL
    context.lineWidth = 2
    context.stroke()
  }
  const cpu = record && frame ? dialCpuAt(record, model.runTime) : 0
  const alarm = record && frame ? alarmAt(record, model.runTime) : 'ok'
  const needle = angleOf(cpu)
  context.beginPath()
  context.moveTo(dial.x, dial.y)
  context.lineTo(dial.x + Math.cos(needle) * (dial.r - 6), dial.y + Math.sin(needle) * (dial.r - 6))
  context.strokeStyle = alarm !== 'ok' ? '#9b2c22' : PENCIL
  context.lineWidth = 2.2
  context.stroke()
  context.beginPath()
  context.arc(dial.x, dial.y, 2.5, 0, Math.PI * 2)
  context.fillStyle = PENCIL
  context.fill()

  // The bell, which swings while it rings.
  const ringing = record !== null && bellRingingAt(record, model.runTime)
  const swing = ringing && !model.reducedMotion ? Math.sin(model.time / 55) * 0.55 : 0
  context.strokeStyle = PENCIL
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(x, y - 104)
  context.lineTo(x + 18, y - 104)
  context.stroke()
  context.save()
  context.translate(x + 18, y - 104)
  context.rotate(swing)
  context.beginPath()
  context.moveTo(-7, 13)
  context.quadraticCurveTo(-6, 1, 0, 1)
  context.quadraticCurveTo(6, 1, 7, 13)
  context.closePath()
  context.fillStyle = '#d9b44a'
  context.fill()
  context.stroke()
  context.restore()
  context.restore()
  if (ringing) caption(context, 'ding!', x + 30, y - 112, 12, 'left', '#7a5a12')

  // The readout, in the open sky above: minute, CPU against the target, alarm, room.
  const left = x - 28
  caption(context, 'CloudWatch', left, y - 216, 14, 'left')
  if (!tick) {
    caption(context, 'CPU of the targets', left, y - 198, 11, 'left', '#57536a')
    return
  }
  caption(context, `Minute ${frame.index}`, left, y - 198, 12, 'left', '#57536a')
  caption(
    context,
    `CPU ${Math.round(cpu)}%${target !== undefined ? ` · target ${target}%` : ''}`,
    left,
    y - 180,
    14,
    'left',
  )
  if (alarm !== 'ok') {
    // A square red badge with words, so the alarm never depends on colour alone.
    const text =
      alarm === 'high-cpu' ? 'ALARM: CPU high, scaling out' : 'ALARM: CPU low, scaling in'
    context.save()
    context.font = `11px ${CAPTION_FONT}`
    const width = context.measureText(text).width + 12
    context.fillStyle = '#9b2c22'
    context.fillRect(left, y - 170, width, 17)
    context.fillStyle = '#ffffff'
    context.textBaseline = 'middle'
    context.fillText(text, left + 6, y - 161.5)
    context.restore()
  } else if (target === undefined) {
    // No scaling policy, so no alarm: CloudWatch measures, but nothing acts on it.
    caption(context, 'No alarm: no scaling policy', left, y - 161, 11, 'left', '#57536a')
  } else if (policyIdle) {
    caption(context, `${policyGroup.name}: 0%, gets no kites`, left, y - 161, 11, 'left', '#8a4b12')
  } else {
    caption(context, 'OK', left, y - 161, 12, 'left', '#2f5f34')
  }
  caption(context, `${tick.demand} kites · room for ${tick.capacity}`, left, y - 143, 12, 'left')
  caption(
    context,
    `${tick.targetsInService} healthy host${tick.targetsInService === 1 ? '' : 's'}`,
    left,
    y - 127,
    12,
    'left',
    tick.targetsInService === 0 ? '#9b2c22' : '#57536a',
  )
}

/** Splits text into lines no wider than `maxWidth` at the current font. */
function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const attempt = line ? `${line} ${word}` : word
    if (line && context.measureText(attempt).width > maxWidth) {
      lines.push(line)
      line = word
    } else line = attempt
  }
  if (line) lines.push(line)
  return lines
}

/**
 * A clicked Cloudling says what it wants in a speech bubble above its head. It
 * replaces the caption that used to sit under every Cloudling.
 */
function drawSpeech(
  context: CanvasRenderingContext2D,
  model: SkyViewModel,
  crowdFrame: CrowdFrame | null,
): void {
  const speech = model.speech
  if (!speech) return
  const index = model.level.population.findIndex((kite) => kite.id === speech.kiteId)
  const kite = model.level.population[index]
  if (!kite) return
  // In a crowd level the regulars stand in the crowd once it has gathered.
  const feet =
    crowdFrame && model.level.crowd
      ? (crowdSpots(model.level.population)[index] ?? cloudlingPosition(kite.groundPosition))
      : cloudlingPosition(kite.groundPosition)
  const hostile = kite.kind === 'hostile'

  context.save()
  context.font = `13px ${CAPTION_FONT}`
  const lines = wrapText(context, kite.says, 190)
  const width = Math.max(...lines.map((line) => context.measureText(line).width)) + 22
  const height = lines.length * 17 + 14
  const tipY = feet.y - 72
  // Up and to the left of the head, so the kite (held to the right) stays in view.
  const x = Math.min(Math.max(feet.x + 8 - width, SKY.left + 6), SKY.right - width - 6)
  const y = tipY - 12 - height
  const fadeIn = model.reducedMotion ? 1 : Math.min(1, speech.age / 140)
  const fadeOut = Math.min(1, (SPEECH_DURATION - speech.age) / 400)
  context.globalAlpha = Math.max(0, Math.min(fadeIn, fadeOut))

  context.fillStyle = 'rgba(253, 250, 240, 0.97)'
  context.strokeStyle = hostile ? '#7c1d1d' : PENCIL
  context.lineWidth = 1.6
  roundedRectPath(context, { x, y, width, height }, 10)
  context.fill()
  context.stroke()
  // The tail points down at the speaker's head.
  const tailX = Math.min(Math.max(feet.x, x + 16), x + width - 16)
  context.beginPath()
  context.moveTo(tailX - 7, y + height - 1)
  context.lineTo(feet.x, tipY)
  context.lineTo(tailX + 7, y + height - 1)
  context.closePath()
  context.fill()
  context.beginPath()
  context.moveTo(tailX - 7, y + height)
  context.lineTo(feet.x, tipY)
  context.lineTo(tailX + 7, y + height)
  context.stroke()

  context.fillStyle = hostile ? '#7c1d1d' : '#2f3b2b'
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  lines.forEach((line, row) => context.fillText(line, x + 11, y + 15 + row * 17))
  context.restore()
}

function drawDrag(context: CanvasRenderingContext2D, model: SkyViewModel): void {
  const drag = model.drag
  if (!drag) return
  context.save()
  if (drag.kind === 'place') {
    // Only the zone under the pointer lights up: the player has to find where the cloud belongs.
    const hovered = zoneAt(drag.zones, drag.point)
    if (hovered) {
      const pulse = model.reducedMotion ? 0.5 : 0.5 + Math.sin(model.time / 220) * 0.15
      context.fillStyle = `rgba(255, 255, 255, ${0.35 + pulse * 0.25})`
      context.strokeStyle = '#3f6fa8'
      context.lineWidth = 2.5
      context.setLineDash([7, 5])
      roundedRectPath(context, hovered.rect, 12)
      context.fill()
      context.stroke()
    }
    // The ghost follows the pointer. The S3 tower is drawn at half size so it does not hide the sky.
    const size = spriteSize(drag.resourceKind)
    const scale = drag.resourceKind === 's3-bucket' ? 0.5 : 1
    const width = size.width * scale
    const height = size.height * scale
    drawCloud(
      context,
      GENUS_OF[drag.resourceKind],
      drag.point.x - width / 2,
      drag.point.y - height / 2,
      width,
      height,
      { tint: ['#dbe9f5'], sunlight: 0, burst: 0, opacity: 0.75 },
    )
  } else {
    context.strokeStyle = '#6a6578'
    context.lineWidth = 2
    context.setLineDash([5, 5])
    context.beginPath()
    context.moveTo(drag.from.x, drag.from.y)
    context.lineTo(drag.to.x, drag.to.y)
    context.stroke()
  }
  context.restore()
}

export function drawSky(context: CanvasRenderingContext2D, model: SkyViewModel): void {
  const theme = REGION_THEMES[model.level.region]
  drawBackdrop(context, theme)
  drawContainers(context, model)
  drawConnections(context, model)

  // White burst on the cloud a kite has just been delivered into.
  const burstFor: Record<string, number> = {}
  for (const script of model.scripts) {
    const frame = frameAt(script, model.runTime)
    if (frame.phase !== 'ending' || script.ending !== 'delivered' || model.reducedMotion) continue
    const last = [...script.beats].reverse().find((beat) => beat.carrier === 'kite')
    if (last?.step.at.kind === 'resource')
      burstFor[last.step.at.id] = Math.max(0, 1 - frame.endingProgress * 2.5)
  }
  const crowdFrame = model.crowd ? crowdFrameAt(model.crowd, model.runTime) : null
  drawClouds(context, model, burstFor, crowdFrame)
  drawOutage(context, model)
  drawHighlight(context, model)
  if (crowdFrame) drawCrowdStream(context, model, crowdFrame)
  if (model.level.crowd) drawWeatherStation(context, model, crowdFrame)

  if (crowdFrame && model.crowd) {
    drawCrowd(context, model, theme.costume)
  } else {
    for (const kite of model.level.population) {
      drawKiteAndCloudling(
        context,
        model,
        kite,
        model.scripts.find((script) => script.kiteRun.kite.id === kite.id),
        theme.costume,
      )
    }
  }
  drawSpeech(context, model, crowdFrame)
  drawDrag(context, model)

  // Lightning belongs to failure: a brief flash when a breach happens.
  for (const script of model.scripts) {
    const frame = frameAt(script, model.runTime)
    if (
      script.ending === 'breach' &&
      frame.phase === 'ending' &&
      frame.endingProgress < 0.18 &&
      !model.reducedMotion
    ) {
      context.fillStyle = `rgba(255, 255, 255, ${0.7 - frame.endingProgress * 3.5})`
      context.fillRect(0, 0, STAGE.width, STAGE.height)
    }
  }
}
