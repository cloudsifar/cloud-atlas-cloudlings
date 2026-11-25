// The panels around the sky: palette tray, objectives, narrator, trace
// inspector, fact cards and the results card. Each function builds DOM from the
// current state; none of them holds state of its own.

import {
  costOfScene,
  crowdTimeline,
  resourcesOfKind,
  type TickRecord,
  expandAutoScalingGroups,
  failingStep,
  type ResourceKind,
  type ResourceRef,
  type Scene,
  type TraceStep,
} from '../engine'
import {
  BAND_OF,
  CHECK_LABELS,
  crowdLog,
  drawCloud,
  fleetSizes,
  GENUS_OF,
  membersFailed,
  membersTimedOut,
  OUTCOME_LABELS,
  playedTicks,
  settledFrom,
  type GameState,
  type LogEntry,
} from '../game'
import { FACT_CARDS, REGION_NAMES, textSegments, type KiteRun, type PaletteEntry } from '../levels'
import explanations from '../../content/explanations.json'
import { button, h } from './dom'

export const EXPLANATIONS: Record<string, { label: string; placement: string }> = explanations

// ---------------------------------------------------------------------------
// Palette tray
// ---------------------------------------------------------------------------

const BAND_HEADINGS = {
  low: 'Low – public',
  mid: 'Mid – private',
  high: 'High – account',
  vertical: 'Every altitude',
}

/** The service-family icon: a small silhouette of the family's cloud genus. */
function familyIcon(kind: ResourceKind): HTMLCanvasElement {
  const icon = h('canvas', {
    class: 'family-icon',
    width: 72,
    height: 40,
    attrs: { 'aria-hidden': 'true' },
  })
  const context = icon.getContext('2d')
  // The S3 tower is tall and thin; every other genus is wider than it is high.
  const [width, height] = kind === 's3-bucket' ? [20, 34] : [60, 30]
  if (context)
    drawCloud(context, GENUS_OF[kind], (72 - width) / 2, (40 - height) / 2, width, height, {
      tint: ['#aecfeb'],
      sunlight: 0,
      burst: 0,
      opacity: 1,
    })
  return icon
}

export function renderPalette(
  state: GameState,
  highlight: string | null,
  onDragStart: (entry: PaletteEntry, event: PointerEvent) => void,
  /** `fromKeyboard` is true for Enter or Space, false for a mouse or touch click. */
  onActivate: (entry: PaletteEntry, fromKeyboard: boolean) => void,
): HTMLElement[] {
  const available = state.level.palette.filter(
    (entry) => !state.scene.resources.some((resource) => resource.id === entry.resource.id),
  )
  const parts: HTMLElement[] = [h('h2', { textContent: 'Clouds' })]
  if (state.level.palette.length === 0) {
    parts.push(
      h('p', {
        class: 'note',
        textContent: 'Nothing to add in this level: everything you need is already in the sky.',
      }),
    )
  } else if (available.length === 0) {
    parts.push(h('p', { class: 'note', textContent: 'Every cloud is in the sky.' }))
  }
  for (const band of ['low', 'mid', 'high', 'vertical'] as const) {
    const entries = available.filter((entry) => BAND_OF[entry.resource.kind] === band)
    if (entries.length === 0) continue
    parts.push(h('h3', { textContent: BAND_HEADINGS[band] }))
    for (const entry of entries) {
      const id = entry.resource.id
      const card = h(
        'button',
        {
          type: 'button',
          class: `specimen${highlight === `palette:${id}` ? ' pointed-at' : ''}`,
          disabled: state.phase === 'flying',
          attrs: {
            'data-focus-key': `palette-${id}`,
            'data-palette-id': id,
            title: 'Drag into the sky and let go where it lights up, or press Enter to place',
          },
        },
        familyIcon(entry.resource.kind),
        h('span', {
          class: 'specimen-name',
          textContent: EXPLANATIONS[entry.resource.kind]?.label ?? entry.resource.name,
        }),
      )
      card.onpointerdown = (event) => onDragStart(entry, event)
      // Enter or Space places the cloud in its default spot: the keyboard route. A mouse
      // click does not, since the player is meant to find where the cloud goes (ADR 0007).
      // A click from the keyboard has no pointer behind it, so its `detail` is 0.
      card.onclick = (event) => onActivate(entry, event.detail === 0)
      parts.push(card)
    }
  }
  return parts
}

// ---------------------------------------------------------------------------
// Objectives, stars and hints
// ---------------------------------------------------------------------------

/** Which crowd kite's journey to open in the trace inspector: one from a given tick. */
export type CrowdKiteChoice = { tick: number; fate: 'served' | 'timed-out' | 'stopped' }

/**
 * The objectives, stars and running cost. `ticked` is how many objectives have ticked
 * since the kites landed: they tick one at a time, in the level's order, and the stars
 * wait until all of them have (ADR 0011).
 */
export function renderObjectives(
  state: GameState,
  onHint: (objectiveId: string) => void,
  onFollowCrowdKite: (choice: CrowdKiteChoice) => void = () => {},
  ticked: number = Number.POSITIVE_INFINITY,
  /** In a crowd level, the minute the flying crowd has reached (ADR 0012). */
  crowdMinute: number | null = null,
): HTMLElement[] {
  const { level, lastRun, lastRunIsCurrent } = state
  const judged = lastRun !== null && lastRunIsCurrent && state.phase !== 'flying'
  const allTicked = ticked >= level.objectives.length
  const parts: HTMLElement[] = [h('h2', { textContent: 'Objectives' })]

  const list = h('ul', { class: 'objectives' })
  for (const [index, objective] of level.objectives.entries()) {
    const met =
      judged &&
      index < ticked &&
      (lastRun?.objectives.find((result) => result.id === objective.id)?.met ?? false)
    const tier = state.hintTiers[objective.id] ?? 0
    const hint = level.hints.find((candidate) => candidate.objectiveId === objective.id)
    const item = h(
      'li',
      { class: met ? 'met' : '' },
      h('span', { class: 'tick', textContent: met ? '☑' : '☐', attrs: { 'aria-hidden': 'true' } }),
      h('span', { textContent: objective.text }),
      h('span', { class: 'visually-hidden', textContent: met ? ' (met)' : ' (not met yet)' }),
    )
    if (hint) {
      const tiers = [hint.nudge, hint.pointer.text, hint.nearAnswer]
      for (let shown = 0; shown < tier; shown++)
        item.append(h('p', { class: 'hint', textContent: tiers[shown] ?? '' }))
      // While the objectives are still ticking, one not yet reached offers no hint: it may
      // be about to tick.
      const waitingToTick = judged && index >= ticked
      if (tier < 3 && !met && !waitingToTick) {
        item.append(
          button(
            tier === 0 ? 'Hint' : 'Another hint',
            () => onHint(objective.id),
            `hint-${objective.id}`,
            'link',
          ),
        )
      }
    }
    list.append(item)
  }
  parts.push(list)
  if (!judged)
    parts.push(
      h('p', {
        class: 'note',
        textContent:
          state.phase === 'flying' ? 'Kites are flying…' : 'Fly the kites to test your sky.',
      }),
    )

  // Running cost, for levels whose goals mention it. Coins are not prices, and say so.
  const usesCost = [
    ...level.objectives.map((objective) => objective.predicate),
    ...level.stars.wellArchitected.predicates,
  ].some((predicate) => predicate.kind === 'cost-at-most')
  if (usesCost) {
    const cost = costOfScene(state.scene)
    parts.push(
      h('h2', { textContent: 'Running cost' }),
      h('p', { class: 'cost-total', textContent: `${cost.total} coins` }),
      h(
        'ul',
        { class: 'cost-lines' },
        ...cost.lines.map((line) => h('li', { textContent: `${line.name}: ${line.coins}` })),
      ),
      h('p', {
        class: 'note',
        textContent: 'Coins are illustrative units for comparing choices, not real AWS prices.',
      }),
    )
  }

  // The weather station: CloudWatch's view of the crowd, for levels that have one.
  if (level.crowd)
    parts.push(...renderWeatherStation(state, judged, onFollowCrowdKite, crowdMinute))

  parts.push(h('h2', { textContent: 'Stars' }))
  const stars = judged && allTicked ? lastRun?.stars : undefined
  const starRow = (earned: boolean | undefined, text: string) =>
    h(
      'li',
      { class: earned ? 'met' : '' },
      h('span', {
        class: 'tick',
        textContent: earned ? '★' : '☆',
        attrs: { 'aria-hidden': 'true' },
      }),
      h('span', { textContent: text }),
    )
  parts.push(
    h(
      'ul',
      { class: 'objectives' },
      starRow(stars?.works, 'It works: every objective met'),
      starRow(stars?.leastPrivilege, 'Least privilege: nothing opens more than it needs'),
      starRow(stars?.wellArchitected, `Well architected: ${level.stars.wellArchitected.text}`),
    ),
  )
  if (judged && stars?.works && lastRun && lastRun.findings.length > 0) {
    parts.push(h('p', { class: 'note', textContent: 'For the least-privilege star:' }))
    parts.push(
      h(
        'ul',
        { class: 'findings' },
        ...lastRun.findings.map((finding) => h('li', { textContent: finding.message })),
      ),
    )
  }
  return parts
}

// ---------------------------------------------------------------------------
// Weather station: CloudWatch's view of a crowd
// ---------------------------------------------------------------------------

/** Each cloud's name by id, so CloudWatch's log can name the database. */
function resourceNames(state: GameState): Record<string, string> {
  return Object.fromEntries(state.scene.resources.map((resource) => [resource.id, resource.name]))
}

/** The scaling policy's CPU target, if a group in the scene has one. */
function targetPercent(state: GameState): number | null {
  const group = resourcesOfKind(state.scene, 'auto-scaling-group').find(
    (candidate) => candidate.scaling !== null,
  )
  return group?.scaling?.targetCpuPercent ?? null
}

/** CloudWatch's log as a list: what changed, minute by minute (crowdPlayback.ts, crowdLog). */
function logList(entries: LogEntry[]): HTMLElement {
  return h(
    'ol',
    { class: 'cloudwatch-log' },
    ...entries.map((entry) =>
      h(
        'li',
        { class: `log-${entry.kind}` },
        h('span', { class: 'log-minute', textContent: `${entry.minute}′` }),
        h('span', { textContent: entry.text }),
      ),
    ),
  )
}

function renderWeatherStation(
  state: GameState,
  judged: boolean,
  onFollowCrowdKite: (choice: CrowdKiteChoice) => void,
  minute: number | null,
): HTMLElement[] {
  const { level, lastRun } = state
  if (!level.crowd) return []
  const parts: HTMLElement[] = [h('h2', { textContent: 'Weather station' })]
  const target = targetPercent(state)

  // While the crowd flies: CloudWatch's log, a line for each change, as it happens.
  if (state.phase === 'flying' && state.lastRunIsCurrent && lastRun?.crowd) {
    const entries = crowdLog(lastRun.crowd, target, resourceNames(state)).filter(
      (entry) => entry.minute <= (minute ?? -1),
    )
    parts.push(
      h('p', { class: 'note', textContent: 'CloudWatch, minute by minute:' }),
      logList(entries.slice(-8)),
    )
    return parts
  }

  const crowd = judged ? lastRun?.crowd : null
  if (!crowd) {
    const sizes = crowdTimeline(level.crowd, level.events).map((moment) => moment.kites)
    const steady = sizes.every((size) => size === sizes[0])
    parts.push(
      h('p', {
        class: 'note',
        textContent: steady
          ? `${sizes[0] ?? 0} Cloudlings each keep one kite up, all day. Fly the kites and watch the sky, and CloudWatch's dial, bottom right.`
          : `A crowd is coming: from ${sizes[0] ?? 0} Cloudlings to ${Math.max(...sizes)}, in groups, then home again. Each keeps one kite up. Fly the kites and watch CloudWatch's dial, bottom right.`,
      }),
    )
    return parts
  }

  // After the run: what happened, in Cloudlings and instances rather than kite counts.
  const peak = Math.max(1, ...crowd.ticks.map((tick) => tick.demand))
  const blocked = crowd.ticks.every((tick) => tick.blocked === tick.demand && tick.demand > 0)
  const timedOutMembers = membersTimedOut(crowd)
  const failedMembers = membersFailed(crowd)
  const failedIn = (tick: TickRecord) => tick.dropped + tick.blocked
  // Failures only while a database failed over: the part no architecture avoids.
  const onlyInFailover =
    crowd.ticks.some((tick) => failedIn(tick) > 0) &&
    crowd.ticks.every(
      (tick) =>
        failedIn(tick) === 0 ||
        tick.databases.some((database) => database.status === 'failing-over'),
    )
  const worst = crowd.ticks.reduce((best, tick) => (failedIn(tick) > failedIn(best) ? tick : best))
  parts.push(
    h('p', {
      class: 'cost-total',
      textContent: blocked
        ? 'No kite could get through'
        : failedMembers === 0
          ? 'Every kite answered, all day'
          : onlyInFailover
            ? 'Every kite answered, except while the database failed over'
            : failedMembers === timedOutMembers
              ? `${timedOutMembers} of ${peak} Cloudlings timed out`
              : `${failedMembers} of ${peak} Cloudlings had a kite fail`,
    }),
  )
  const played = playedTicks(crowd)
  if (played < crowd.ticks.length) {
    // The day settled with nothing answered, so the run stopped early (playedTicks).
    parts.push(
      h('p', {
        class: 'note',
        textContent: `From minute ${settledFrom(crowd)} nothing changed and no kite was answered, so the run stopped after minute ${played - 1}. The rest of the day, to minute ${crowd.ticks.length - 1}, would have gone the same way.`,
      }),
    )
  }
  if (!blocked && failedIn(worst) > 0) {
    // Why the worst minute's kites failed, in the order the engine judged them.
    const database = worst.databases.find((candidate) => candidate.status !== 'available')
    const noRoom = worst.capacity > 0 ? Math.max(0, worst.demand - worst.capacity) : 0
    const reason =
      worst.targetsInService === 0
        ? 'no healthy targets'
        : database?.status === 'failing-over'
          ? 'the database was failing over'
          : database?.status === 'unavailable'
            ? 'the database was down'
            : worst.blocked > 0
              ? 'some were turned away: see the trace'
              : noRoom > 0
                ? `room for ${worst.capacity}`
                : 'see the trace'
    parts.push(
      h('p', {
        class: 'note',
        textContent: `Worst minute: ${worst.tick}, when ${failedIn(worst)} of ${worst.demand} kites failed (${reason}).`,
      }),
    )
  }
  const storm = crowd.ticks.find((tick) => tick.failedZones.length > 0)
  parts.push(
    h('p', {
      class: 'note',
      textContent: storm
        ? `AZ ${storm.failedZones.join(' and ')} failed at minute ${storm.tick}. Healthy instances: ${fleetSizes(crowd).join(' → ')}.`
        : `Instances serving: ${fleetSizes(crowd).join(' → ')}. Before the crowd, CPU was ${crowd.ticks[0]?.cpuPercent ?? 0}%.`,
    }),
  )
  if (storm) {
    // Whether each group could replace what it lost: only in a zone that is still up.
    for (const fleet of crowd.ticks.at(-1)?.fleets ?? []) {
      const name =
        state.scene.resources.find((resource) => resource.id === fleet.groupId)?.name ?? 'The group'
      const replacements = crowd.ticks.reduce(
        (sum, tick) =>
          sum + (tick.fleets.find((each) => each.groupId === fleet.groupId)?.replaced ?? 0),
        0,
      )
      const stranded = fleet.zones.a.failed + fleet.zones.b.failed
      if (replacements > 0) {
        parts.push(
          h('p', {
            class: 'note',
            textContent: `${name} launched ${replacements} replacement${replacements === 1 ? '' : 's'} in the zone that was still up.`,
          }),
        )
      } else if (stranded > 0) {
        parts.push(
          h('p', {
            class: 'note',
            textContent: `${name} had no subnet in another zone, so it had nowhere to launch replacements.`,
          }),
        )
      }
    }
  }
  const lastDatabase = crowd.ticks.at(-1)?.databases[0]
  if (lastDatabase) {
    const failoverMinutes = crowd.ticks.filter((tick) =>
      tick.databases.some((database) => database.status === 'failing-over'),
    ).length
    const name =
      state.scene.resources.find((resource) => resource.id === lastDatabase.databaseId)?.name ??
      'The database'
    parts.push(
      h('p', {
        class: 'note',
        textContent:
          lastDatabase.status === 'unavailable'
            ? `${name} went down with its zone: it had no standby.`
            : failoverMinutes > 0
              ? `${name} failed over to AZ ${lastDatabase.primaryZone} in ${failoverMinutes} minutes.`
              : `${name} answered all day, from AZ ${lastDatabase.primaryZone}.`,
      }),
    )
  }

  // One bar per minute: solid for kites answered, hatched for kites that were not.
  parts.push(
    h(
      'div',
      {
        class: 'crowd-chart',
        attrs: {
          role: 'img',
          'aria-label': `Kites each minute, ${crowd.ticks.length} minutes; hatched parts of a bar were not answered`,
        },
      },
      ...crowd.ticks.map((tick) => {
        const failed = tick.dropped + tick.blocked
        return h(
          'div',
          {
            class: 'crowd-bar',
            title: `Minute ${tick.tick}: ${tick.delivered} answered, ${failed} not, room for ${tick.capacity}`,
          },
          h('div', {
            class: 'not-delivered',
            attrs: { style: `height:${(failed / peak) * 48}px` },
          }),
          h('div', {
            class: 'delivered',
            attrs: { style: `height:${(tick.delivered / peak) * 48}px` },
          }),
        )
      }),
    ),
  )

  // Open the journey of one kite from the crowd: the engine kept one for each fate.
  const busiest = (fits: (tick: TickRecord) => boolean, by: (tick: TickRecord) => number) =>
    crowd.ticks
      .filter(fits)
      .reduce<TickRecord | null>(
        (best, tick) => (best === null || by(tick) > by(best) ? tick : best),
        null,
      )
  const timedOut = busiest(
    (tick) => tick.timedOut !== null,
    (tick) => tick.dropped,
  )
  const served = busiest(
    (tick) => tick.demand > 0,
    (tick) => tick.demand,
  )
  // A kite that reached a target but was turned away after it, or got no answer from
  // the database: the first minute it happened, when the cause is easiest to see.
  const stopped = crowd.ticks.find((tick) => tick.stopped !== null) ?? null
  // A minute with nothing healthy behind the load balancer: it fails open and tries a
  // target anyway, and the kite's journey shows why that target never answers.
  const unserved =
    crowd.ticks.find(
      (tick) => tick.capacity === 0 && tick.demand > 0 && tick.served.outcome === 'dropped',
    ) ?? null
  const follow = h('div', { class: 'follow-buttons' })
  if (unserved) {
    follow.append(
      button(
        'Follow a kite with no healthy instance to answer it',
        () => onFollowCrowdKite({ tick: unserved.tick, fate: 'served' }),
        'follow-unserved',
        'link',
      ),
    )
  }
  if (stopped) {
    follow.append(
      button(
        stopped.stopped?.outcome === 'blocked'
          ? 'Follow a kite that was turned away'
          : 'Follow a kite that got no answer',
        () => onFollowCrowdKite({ tick: stopped.tick, fate: 'stopped' }),
        'follow-stopped',
        'link',
      ),
    )
  }
  if (timedOut) {
    follow.append(
      button(
        'Follow a kite that timed out',
        () => onFollowCrowdKite({ tick: timedOut.tick, fate: 'timed-out' }),
        'follow-timed-out',
        'link',
      ),
    )
  }
  if (served) {
    follow.append(
      button(
        served.served.outcome === 'delivered'
          ? 'Follow a kite that got through'
          : 'Follow a kite that was stopped',
        () => onFollowCrowdKite({ tick: served.tick, fate: 'served' }),
        'follow-served',
        'link',
      ),
    )
  }
  parts.push(follow)

  parts.push(
    h(
      'details',
      { class: 'crowd-log' },
      h('summary', { textContent: 'CloudWatch log' }),
      logList(crowdLog(crowd, target, resourceNames(state))),
    ),
  )
  return parts
}

// ---------------------------------------------------------------------------
// Narrator
// ---------------------------------------------------------------------------

/**
 * Narration text, with any `[phrase](card:id)` links drawn as links that open the
 * fact card: the longer explanation, one click away (ADR 0011).
 */
function narrationText(text: string, onOpenCard: (factCardId: string) => void): HTMLElement {
  const paragraph = h('p', null)
  for (const segment of textSegments(text)) {
    const cardId = segment.factCardId
    if (cardId === undefined) paragraph.append(segment.text)
    else
      paragraph.append(
        button(segment.text, () => onOpenCard(cardId), `narration-card-${cardId}`, 'inline-link'),
      )
  }
  return paragraph
}

export function renderNarrator(
  state: GameState,
  onNext: () => void,
  onOpenCard: (factCardId: string) => void,
): HTMLElement[] {
  const { level, narrationIndex } = state
  const step = level.narration[narrationIndex]
  const portrait = h('div', { class: 'narrator-portrait', attrs: { 'aria-hidden': 'true' } })
  if (!step) {
    return [portrait, h('div', { class: 'narrator-text' }, h('p', { textContent: level.concept }))]
  }
  return [
    portrait,
    h(
      'div',
      { class: 'narrator-text', attrs: { 'aria-live': 'polite' } },
      narrationText(step.text, onOpenCard),
      h('p', {
        class: 'step-count',
        textContent: `Step ${narrationIndex + 1} of ${level.narration.length}`,
      }),
    ),
    ...(step.advanceWhen.kind === 'acknowledged'
      ? [button('Next', onNext, 'narrator-next', 'primary')]
      : []),
  ]
}

// ---------------------------------------------------------------------------
// Trace inspector: the main learning tool
// ---------------------------------------------------------------------------

const LEG_HEADINGS: Record<TraceStep['leg'], string> = {
  request: 'The request',
  'backend-request': 'The application calls another service',
  'backend-response': 'That service replies',
  response: 'The response',
}

function describeRef(scene: Scene, ref: ResourceRef): string {
  switch (ref.kind) {
    case 'ground':
      return 'Ground'
    case 'vpc':
      return 'VPC border'
    case 'subnet':
      return scene.subnets.find((subnet) => subnet.id === ref.id)?.name ?? 'Subnet'
    case 'resource':
      // Looked up with Auto Scaling groups expanded, so "asg#2" has a name.
      return (
        expandAutoScalingGroups(scene).resources.find((resource) => resource.id === ref.id)?.name ??
        'Resource'
      )
  }
}

export function renderTraceInspector(
  kiteRun: KiteRun,
  scene: Scene,
  onClose: () => void,
): HTMLElement {
  const { kite, result } = kiteRun
  const steps = [...result.trace, ...(result.responseTrace ?? [])]
  const failed = failingStep(result)
  const good =
    kite.kind === 'hostile'
      ? result.outcome === 'blocked' || result.outcome === 'dropped'
      : result.outcome === 'delivered'

  const body = h('ol', { class: 'trace' })
  let previousLeg: TraceStep['leg'] | null = null
  steps.forEach((step, index) => {
    if (step.leg !== previousLeg) {
      body.append(h('li', { class: 'leg-heading', textContent: LEG_HEADINGS[step.leg] }))
      previousLeg = step.leg
    }
    const passed = step.result === 'pass'
    // A red kite stopped by a check is the defence working, not a fault to fix (ADR 0009).
    const blocked = !passed && kite.kind === 'hostile'
    body.append(
      h(
        'li',
        { class: `trace-step ${passed ? 'pass' : blocked ? 'blocked' : 'fail'}` },
        h('span', { class: 'step-number', textContent: String(index + 1) }),
        h('span', {
          class: 'step-mark',
          textContent: passed ? '✓ pass' : blocked ? '⛨ blocked here' : '✗ stopped here',
        }),
        h('strong', {
          textContent: `${CHECK_LABELS[step.check]} · ${describeRef(scene, step.at)}`,
        }),
        step.ruleRef ? h('span', { class: 'rule-ref', textContent: step.ruleRef }) : null,
        h('p', { textContent: step.explanation }),
      ),
    )
  })

  return h(
    'div',
    { class: 'config-card trace-card', attrs: { role: 'dialog', 'aria-label': 'Kite journey' } },
    h(
      'header',
      { class: 'card-header' },
      h(
        'div',
        null,
        h('h3', {
          textContent: `${kite.kind === 'hostile' ? 'Red kite' : 'Green kite'}: ${kite.label}`,
        }),
        h('p', {
          class: 'subtitle',
          textContent: `From ${kite.ip} · port ${kite.port}${kite.payload === 'malicious' ? ' · malicious payload' : ''}`,
        }),
      ),
      h('button', {
        type: 'button',
        class: 'close',
        textContent: '×',
        onclick: onClose,
        attrs: { 'aria-label': 'Close', 'data-focus-key': 'card-close' },
      }),
    ),
    h(
      'p',
      { class: `outcome ${good ? 'good' : 'bad'}` },
      // Turned away by a check; timed out (nothing answered) at one.
      `${OUTCOME_LABELS[result.outcome]}${failed ? ` ${result.outcome === 'dropped' ? 'at' : 'by'} ${CHECK_LABELS[failed.check]}` : ''}. `,
      kite.kind === 'hostile'
        ? good
          ? 'The attacker was stopped: that is what you want.'
          : 'The attacker got through.'
        : good
          ? 'The visitor was served.'
          : result.outcome === 'dropped'
            ? 'The visitor got no answer: something needs fixing.'
            : 'A visitor was turned away: something needs fixing.',
    ),
    body,
  )
}

// ---------------------------------------------------------------------------
// Fact cards and results
// ---------------------------------------------------------------------------

export function renderFactCard(id: string, onClose: () => void): HTMLElement | null {
  const card = FACT_CARDS[id]
  if (!card) return null
  return h(
    'div',
    { class: 'modal', attrs: { role: 'dialog', 'aria-label': card.title } },
    h(
      'div',
      { class: 'fact-card' },
      h('h3', { textContent: card.title }),
      h('p', { textContent: card.body }),
      card.points && card.points.length > 0
        ? h(
            'ul',
            { class: 'fact-points' },
            ...card.points.map((text) => h('li', { textContent: text })),
          )
        : null,
      card.simplifications.length > 0 ? h('h4', { textContent: 'Simplified in this game' }) : null,
      card.simplifications.length > 0
        ? h('ul', null, ...card.simplifications.map((text) => h('li', { textContent: text })))
        : null,
      h('p', { class: 'atlas-ref', textContent: `Read more in Cloud Atlas, p. ${card.atlasPage}` }),
      button('Close', onClose, 'fact-close', 'primary'),
    ),
  )
}

export function renderResults(
  state: GameState,
  actions: { keepBuilding(): void; nextLevel: (() => void) | null; toMenu(): void },
): HTMLElement | null {
  const run = state.lastRun
  if (!run) return null
  const star = (earned: boolean, label: string) =>
    h(
      'li',
      { class: earned ? 'met' : '' },
      h('span', {
        class: 'big-star',
        textContent: earned ? '★' : '☆',
        attrs: { 'aria-hidden': 'true' },
      }),
      h('span', { textContent: `${label}${earned ? '' : ' (not yet)'}` }),
    )
  return h(
    'div',
    { class: 'modal', attrs: { role: 'dialog', 'aria-label': 'Level complete' } },
    h(
      'div',
      { class: 'fact-card results' },
      h('h3', { textContent: `Level ${state.level.id} complete: ${state.level.title}` }),
      h('p', {
        class: 'subtitle',
        textContent: `${REGION_NAMES[state.level.region]} · ${state.level.region}`,
      }),
      h(
        'ul',
        { class: 'stars' },
        star(run.stars.works, 'It works'),
        star(run.stars.leastPrivilege, 'Least privilege'),
        star(
          run.stars.wellArchitected,
          `Well architected: ${state.level.stars.wellArchitected.text}`,
        ),
      ),
      run.findings.length > 0
        ? h(
            'ul',
            { class: 'findings' },
            ...run.findings.map((finding) => h('li', { textContent: finding.message })),
          )
        : null,
      h('h4', { textContent: 'What you learned' }),
      ...state.level.factCards.map((id) => {
        const card = FACT_CARDS[id]
        return card
          ? h(
              'details',
              null,
              h('summary', { textContent: card.title }),
              h('p', { textContent: card.body }),
            )
          : null
      }),
      h(
        'div',
        { class: 'button-row' },
        button('Keep building', actions.keepBuilding, 'results-keep', 'quiet'),
        button('Level select', actions.toMenu, 'results-menu', 'quiet'),
        actions.nextLevel
          ? button('Next level', actions.nextLevel, 'results-next', 'primary')
          : null,
      ),
    ),
  )
}
