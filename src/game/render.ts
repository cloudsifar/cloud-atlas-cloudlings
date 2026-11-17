// Drawing the sky. One function, `drawSky`, paints a whole frame from a view
// model; it keeps no state of its own and decides nothing about the game.
//
// The visual grammar (brief, Section 5) is fixed: altitude means distance from
// the internet, each control blocks with its own object, gold means only "a
// change took effect", red-with-smoke means compromised.

import {
  failingStep,
  isPublicSubnet,
  resolveRoute,
  resourcesOfKind,
  runningCount,
  type CheckKind,
  type CrowdRecord,
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
  GENUS_OF,
  handlePosition,
  SKY,
  spriteSize,
  STAGE,
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
  alongPath,
  ARRIVAL,
  bellRingingAt,
  crowdFrameAt,
  crowdPaths,
  crowdSpots,
  fateOf,
  WEATHER_STATION,
  type CrowdFrame,
} from './crowdPlayback'
import { frameAt, type KiteFrame, type KiteScript } from './playback'

const PAPER = '#f6efdc'

/** Cloud blues by altitude: palest low, deepest high. The shade carries no other meaning. */
const BAND_TINT = { low: '#d6e8f6', mid: '#aecfeb', high: '#86b4dc' }
const GREY_TINT = '#c4c4c8'
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
  | { kind: 'place'; resourceKind: ResourceKind; point: Point; zones: Rect[] }
  | { kind: 'connect'; from: Point; to: Point }

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
  highlight: string | null
  selectedKiteId: string | null
  drag: DragView | null
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
  const bandLabel = (text: string, top: number, bottom: number) => {
    context.save()
    context.translate(SKY.left + 14, (top + bottom) / 2)
    context.rotate(-Math.PI / 2)
    caption(context, text, 0, 0, 12, 'center', '#4c5878')
    context.restore()
  }
  bandLabel('High – managed services', SKY.high.top, SKY.high.bottom + 6)
  bandLabel('Mid – private', SKY.mid.top, SKY.mid.bottom)
  bandLabel('Low – public', SKY.low.top, SKY.low.bottom)
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
  context.moveTo(vpc.x + vpc.width - 96, vpc.y - 12)
  context.lineTo(vpc.x + vpc.width - 60, vpc.y)
  context.stroke()
  context.restore()
  caption(context, `VPC ${scene.vpc.cidr}`, vpc.x + vpc.width - 100, vpc.y - 14, 13, 'right')

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
    context.save()
    context.fillStyle = 'rgba(255, 255, 255, 0.2)'
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
      const isPublic = isPublicSubnet(scene, subnet)
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
 * An Auto Scaling group: one small altocumulus cloudlet per instance, in up to two
 * offset rows. Instances still launching are drawn faint, so the fleet visibly grows.
 */
function drawFleet(
  context: CanvasRenderingContext2D,
  rect: Rect,
  inService: number,
  launching: number,
  look: { tint: string[]; sunlight: number; burst: number; opacity: number },
): void {
  const total = Math.max(1, inService + launching)
  const rows = total <= 3 ? 1 : 2
  const columns = Math.ceil(total / rows)
  const width = Math.round(Math.min(50, (rect.width - 8) / (columns + (rows > 1 ? 0.5 : 0))))
  const height = Math.round(Math.min(rect.height / rows - 2, width * 0.66))
  const gridWidth = columns * width + (rows > 1 ? width / 2 : 0)
  const left = rect.x + (rect.width - gridWidth) / 2
  const top = rect.y + (rect.height - rows * height) / 2
  for (let index = 0; index < inService + launching; index++) {
    const row = Math.floor(index / columns)
    const column = index % columns
    drawCloud(
      context,
      'altocumulus',
      left + column * width + (row % 2) * (width / 2),
      top + row * height,
      width,
      height,
      { ...look, opacity: index < inService ? look.opacity : look.opacity * 0.35 },
    )
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
      // A fleet is a patch of cloudlets, one per instance, that grows and shrinks.
      // During a crowd run the engine's record says how many are serving and launching.
      const fleet = crowdFrame?.tick.fleets.find((candidate) => candidate.groupId === resource.id)
      drawFleet(
        context,
        { ...rect, y },
        fleet?.inService ?? runningCount(resource),
        fleet?.launching ?? 0,
        look,
      )
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
    caption(context, resource.name, centreOf(rect).x, labelY, 12)
    if (resource.kind === 'auto-scaling-group') {
      const policy = resource.scaling
        ? `CPU target ${resource.scaling.targetCpuPercent}%`
        : 'no scaling'
      caption(
        context,
        `${resource.min}–${resource.max} instances · ${policy}`,
        centreOf(rect).x,
        labelY + 12,
        11,
        'center',
        '#3c4a78',
      )
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
  if (!model.highlight) return
  const [kind, id] = model.highlight.split(':')
  const rect =
    kind === 'resource'
      ? model.layout.clouds[id ?? '']
      : kind === 'subnet'
        ? model.layout.subnets[id ?? '']
        : undefined
  if (!rect) return
  const pulse = model.reducedMotion ? 0 : Math.sin(model.time / 260) * 3
  context.save()
  context.strokeStyle = '#c86a1c'
  context.lineWidth = 3
  context.setLineDash([10, 6])
  roundedRectPath(context, rect, 20, 12 + pulse)
  context.stroke()
  context.restore()
}

// ---------------------------------------------------------------------------
// Cloudlings, kites and what happens to them
// ---------------------------------------------------------------------------

function marker(
  context: CanvasRenderingContext2D,
  at: Point,
  passed: boolean,
  label?: string,
): void {
  // Shape as well as colour: a round tick for a pass, a square cross for a fail.
  context.save()
  context.lineWidth = 1.6
  context.strokeStyle = '#ffffff'
  context.fillStyle = passed ? '#3c8a4a' : '#b3342c'
  context.beginPath()
  if (passed) context.arc(at.x, at.y, 6, 0, Math.PI * 2)
  else context.rect(at.x - 7, at.y - 7, 14, 14)
  context.fill()
  context.beginPath()
  if (passed) {
    context.moveTo(at.x - 3, at.y)
    context.lineTo(at.x - 1, at.y + 2.5)
    context.lineTo(at.x + 3.5, at.y - 2.5)
  } else {
    context.moveTo(at.x - 3.5, at.y - 3.5)
    context.lineTo(at.x + 3.5, at.y + 3.5)
    context.moveTo(at.x + 3.5, at.y - 3.5)
    context.lineTo(at.x - 3.5, at.y + 3.5)
  }
  context.stroke()
  context.restore()
  if (label)
    caption(context, label, at.x + 12, at.y - 12, 12, 'left', passed ? '#255c31' : '#8c1f1f')
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
  caption(context, kite.label, feet.x, feet.y + 14, 11, 'center', hostile ? '#7c1d1d' : '#2f4a2b')

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
    const label =
      newest || failed ? CHECK_LABELS[beat.step.check] : selected ? String(index + 1) : undefined
    marker(context, jitter, !failed, label)
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
 * A crowd run, one tick at a time. Every Cloudling present flies a kite each tick:
 * it climbs the path the engine's journey for its fate took, then either vanishes
 * into the cloud with a little rain falling back (delivered), goes slack and drifts
 * down (timed out), or meets the control that stopped it (blocked). Who gets which
 * fate comes from the engine's counts (crowdPlayback.ts); nothing is decided here.
 */
function drawCrowd(
  context: CanvasRenderingContext2D,
  model: SkyViewModel,
  frame: CrowdFrame,
  costume: string,
): void {
  const spots = crowdSpots(model.level.population)
  const paths = crowdPaths(frame.tick, model.scene, model.layout)
  const stoppedBy = failingStep(frame.tick.served)?.check
  const { tick, previous, progress } = frame
  const settled = progress >= 1
  const present = Math.min(spots.length, tick.demand)
  const before = previous ? Math.min(spots.length, previous.demand) : present
  const ease = (amount: number) => 1 - (1 - amount) * (1 - amount)
  const lerp = (from: Point, to: Point, amount: number): Point => ({
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  })

  // The back row first, so the front row stands in front of it.
  const members = Array.from({ length: Math.max(present, before) }, (_, member) => member).sort(
    (first, second) => (spots[first]?.y ?? 0) - (spots[second]?.y ?? 0),
  )
  for (const member of members) {
    const feet = spots[member]
    if (!feet) continue
    const rest = { x: feet.x + 16, y: feet.y - 78 }
    context.save()

    if (member >= present) {
      // Drifting away: present last tick, gone this one.
      const fade = 1 - progress * 3
      if (fade > 0) {
        context.globalAlpha = fade
        drawCloudling(context, feet.x, feet.y, false, 'idle', costume, model.time)
      }
      context.restore()
      continue
    }
    // Arriving: fades in at the start of the tick.
    if (member >= before && !settled) context.globalAlpha = Math.min(1, progress * 4)

    const fate = fateOf(member, tick) ?? 'delivered'
    // Kites leave in small staggered groups rather than all at once.
    const stagger = (member % 6) * 0.03
    const local = Math.min(1, Math.max(0, (progress - stagger) / (1 - stagger)))
    const outcome = !settled && local >= ARRIVAL
    const mood: Mood = !outcome
      ? 'idle'
      : fate === 'delivered'
        ? model.reducedMotion
          ? 'idle'
          : 'cheer'
        : 'droop'
    const hand = drawCloudling(context, feet.x, feet.y, false, mood, costume, model.time)
    if (settled && member < model.level.population.length) {
      const kite = model.level.population[member]
      if (kite) caption(context, kite.label, feet.x, feet.y + 14, 11, 'center', '#2f4a2b')
    }

    const path = paths[fate]
    const end = path[path.length - 1] ?? rest
    if (settled) {
      drawString(context, hand, rest, 0, model.time)
      drawKite(context, rest.x, rest.y, false, 'flying', model.reducedMotion ? 0 : model.time, 0.6)
    } else if (!outcome) {
      const at = alongPath(rest, path, ease(local / ARRIVAL))
      drawString(context, hand, at, 0, model.time)
      drawKite(context, at.x, at.y, false, 'flying', model.time, 0.6)
    } else {
      const after = (local - ARRIVAL) / (1 - ARRIVAL)
      if (fate === 'delivered') {
        // The kite has vanished into the cloud; a little rain falls back on its Cloudling.
        if (after < 0.7)
          drawRain(context, { x: feet.x, y: feet.y - 92 + after * 26 }, model.time, 1 - after)
      } else {
        const offset = blockOffset(fate === 'timed-out' ? undefined : stoppedBy, after)
        const sag = Math.max(0, (after - 0.45) / 0.55)
        const at = lerp(
          { x: end.x + offset.x, y: end.y + offset.y },
          { x: rest.x, y: rest.y + 26 },
          sag,
        )
        drawString(context, hand, at, 0.4 + sag * 0.4, model.time)
        drawKite(
          context,
          at.x,
          at.y,
          false,
          stoppedBy === 'nacl' && fate === 'blocked' && sag === 0 ? 'tangled' : 'flying',
          model.time,
          0.6,
        )
      }
    }
    context.restore()
  }
}

/**
 * CloudWatch, as a weather station on the ground: a barometer dial for the fleet's
 * CPU, an anemometer that spins faster as more kites fly, and a bell that rings when
 * an alarm goes into ALARM. Shown in levels that have a crowd.
 */
function drawWeatherStation(
  context: CanvasRenderingContext2D,
  model: SkyViewModel,
  frame: CrowdFrame | null,
): void {
  const { x, y } = WEATHER_STATION
  const tick = frame?.tick
  context.save()
  context.strokeStyle = PENCIL
  context.lineCap = 'round'
  context.lineWidth = 2

  // Post and tripod feet.
  context.beginPath()
  context.moveTo(x, y)
  context.lineTo(x, y - 74)
  context.moveTo(x - 11, y)
  context.lineTo(x, y - 14)
  context.lineTo(x + 11, y)
  context.stroke()

  // Anemometer: three cups on arms, spinning with the number of kites in the air.
  const spin =
    model.reducedMotion || !tick || (frame?.progress ?? 1) >= 1
      ? 0.4
      : (model.time / 1000) * (1 + tick.demand / 5)
  context.lineWidth = 1.4
  for (let arm = 0; arm < 3; arm++) {
    const angle = spin + (arm * Math.PI * 2) / 3
    const cup = { x: x + Math.cos(angle) * 13, y: y - 78 + Math.sin(angle) * 4 }
    context.beginPath()
    context.moveTo(x, y - 78)
    context.lineTo(cup.x, cup.y)
    context.stroke()
    context.beginPath()
    context.arc(cup.x, cup.y, 3, 0, Math.PI * 2)
    context.fillStyle = '#e9e2cf'
    context.fill()
    context.stroke()
  }

  // Barometer dial: the fleet's CPU, from 0% (left) to 100% (right).
  const dial = { x, y: y - 44 }
  context.beginPath()
  context.arc(dial.x, dial.y, 12, 0, Math.PI * 2)
  context.fillStyle = '#fffdf5'
  context.fill()
  context.stroke()
  const cpu = tick?.cpuPercent ?? 0
  const needle = Math.PI * 0.75 + (cpu / 100) * Math.PI * 1.5
  context.beginPath()
  context.moveTo(dial.x, dial.y)
  context.lineTo(dial.x + Math.cos(needle) * 9, dial.y + Math.sin(needle) * 9)
  context.strokeStyle = tick && tick.alarm !== 'ok' ? '#9b2c22' : PENCIL
  context.stroke()

  // The bell, which swings while it rings.
  const ringing = model.crowd !== null && bellRingingAt(model.crowd, model.runTime)
  const swing = ringing && !model.reducedMotion ? Math.sin(model.time / 55) * 0.55 : 0
  context.strokeStyle = PENCIL
  context.beginPath()
  context.moveTo(x, y - 64)
  context.lineTo(x + 15, y - 64)
  context.stroke()
  context.save()
  context.translate(x + 15, y - 64)
  context.rotate(swing)
  context.beginPath()
  context.moveTo(-6, 11)
  context.quadraticCurveTo(-5, 1, 0, 1)
  context.quadraticCurveTo(5, 1, 6, 11)
  context.closePath()
  context.fillStyle = '#d9b44a'
  context.fill()
  context.stroke()
  context.restore()
  context.restore()

  // Its words stack above it, clear of the Cloudlings' own labels.
  caption(context, 'CloudWatch', x - 18, y - 124, 12, 'left')
  if (tick && tick.alarm !== 'ok') {
    // A square red badge with words, so the alarm never depends on colour alone.
    const which = tick.alarm === 'high-cpu' ? 'high' : 'low'
    const text = `ALARM (CPU ${which}) · CPU ${cpu}%`
    context.save()
    context.font = `11px ${CAPTION_FONT}`
    const width = context.measureText(text).width + 12
    context.fillStyle = '#9b2c22'
    context.fillRect(x - 18, y - 115, width, 16)
    context.fillStyle = '#ffffff'
    context.textBaseline = 'middle'
    context.fillText(text, x - 12, y - 107)
    context.restore()
  } else if (tick) {
    caption(context, `OK · CPU ${cpu}%`, x - 18, y - 107, 11, 'left', '#2f5f34')
  }
  if (ringing) caption(context, 'ding!', x + 26, y - 74, 11, 'left', '#7a5a12')
}

function drawDrag(context: CanvasRenderingContext2D, model: SkyViewModel): void {
  const drag = model.drag
  if (!drag) return
  context.save()
  if (drag.kind === 'place') {
    // Softly highlight where this cloud may go.
    const pulse = model.reducedMotion ? 0.5 : 0.5 + Math.sin(model.time / 220) * 0.15
    for (const zone of drag.zones) {
      context.fillStyle = `rgba(255, 244, 190, ${0.35 + pulse * 0.25})`
      context.strokeStyle = '#b98a1e'
      context.lineWidth = 2
      context.setLineDash([7, 5])
      roundedRectPath(context, zone, 12)
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
  // In a crowd run, the cloud that served this tick's kites flashes as they arrive.
  const crowdFrame = model.crowd ? crowdFrameAt(model.crowd, model.runTime) : null
  if (crowdFrame && !model.reducedMotion && crowdFrame.tick.delivered > 0) {
    const served = [...crowdFrame.tick.served.trace]
      .reverse()
      .find((step) => step.leg === 'request')
    const flash = Math.max(0, 1 - (crowdFrame.progress - ARRIVAL) * 4)
    if (served?.at.kind === 'resource' && crowdFrame.progress >= ARRIVAL) {
      // An Auto Scaling group's instances ("asg#2") flash as their group's cloud.
      const cloudId = served.at.id.split('#')[0] ?? served.at.id
      burstFor[cloudId] = Math.max(burstFor[cloudId] ?? 0, flash)
    }
  }
  drawClouds(context, model, burstFor, crowdFrame)
  drawHighlight(context, model)
  if (model.level.crowd) drawWeatherStation(context, model, crowdFrame)

  if (crowdFrame && model.crowd) {
    drawCrowd(context, model, crowdFrame, theme.costume)
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
