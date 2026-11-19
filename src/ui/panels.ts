// The panels around the sky: palette tray, objectives, narrator, trace
// inspector, fact cards and the results card. Each function builds DOM from the
// current state; none of them holds state of its own.

import {
  costOfScene,
  crowdTimeline,
  deliveredShare,
  type TickRecord,
  expandAutoScalingGroups,
  failingStep,
  type ResourceKind,
  type ResourceRef,
  type Scene,
  type TraceStep,
} from '../engine'
import { BAND_OF, CHECK_LABELS, drawCloud, GENUS_OF, OUTCOME_LABELS, type GameState } from '../game'
import { FACT_CARDS, REGION_NAMES, type KiteRun, type PaletteEntry } from '../levels'
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
export type CrowdKiteChoice = { tick: number; fate: 'served' | 'timed-out' }

export function renderObjectives(
  state: GameState,
  onHint: (objectiveId: string) => void,
  onFollowCrowdKite: (choice: CrowdKiteChoice) => void = () => {},
): HTMLElement[] {
  const { level, lastRun, lastRunIsCurrent } = state
  const judged = lastRun !== null && lastRunIsCurrent && state.phase !== 'flying'
  const parts: HTMLElement[] = [h('h2', { textContent: 'Objectives' })]

  const list = h('ul', { class: 'objectives' })
  for (const objective of level.objectives) {
    const met =
      judged && (lastRun?.objectives.find((result) => result.id === objective.id)?.met ?? false)
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
      if (tier < 3 && !met) {
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
  if (level.crowd) parts.push(...renderWeatherStation(state, judged, onFollowCrowdKite))

  parts.push(h('h2', { textContent: 'Stars' }))
  const stars = judged ? lastRun?.stars : undefined
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

const ALARM_WORDS: Record<TickRecord['alarm'], string> = {
  ok: '–',
  'high-cpu': 'High',
  'low-cpu': 'Low',
}

function renderWeatherStation(
  state: GameState,
  judged: boolean,
  onFollowCrowdKite: (choice: CrowdKiteChoice) => void,
): HTMLElement[] {
  const { level, lastRun } = state
  if (!level.crowd) return []
  const parts: HTMLElement[] = [h('h2', { textContent: 'Weather station' })]
  const crowd = judged ? lastRun?.crowd : null
  if (!crowd) {
    const busiest = Math.max(
      ...crowdTimeline(level.crowd, level.events).map((moment) => moment.kites),
    )
    parts.push(
      h('p', {
        class: 'note',
        textContent: `A crowd is coming: up to ${busiest} kites per tick. Fly the kites to see how the sky copes.`,
      }),
    )
    return parts
  }

  const peak = Math.max(1, ...crowd.ticks.map((tick) => tick.demand))
  const surgeTicks = crowd.ticks.filter((tick) => tick.surge)
  const surge = deliveredShare(surgeTicks)
  parts.push(
    h('p', {
      class: 'cost-total',
      textContent: `${crowd.delivered} of ${crowd.demand} kites delivered (${crowd.deliveredPercent}%)`,
    }),
  )
  if (surgeTicks.length > 0) {
    parts.push(
      h('p', {
        class: 'note',
        textContent: `During the surge: ${surge.delivered} of ${surge.demand} (${surge.percent}%).`,
      }),
    )
  }

  // One bar per tick: solid for delivered, hatched for kites that did not get through.
  const firstSurge = crowd.ticks.findIndex((tick) => tick.surge)
  parts.push(
    h(
      'div',
      {
        class: 'crowd-chart',
        attrs: {
          role: 'img',
          'aria-label': `Kites per tick, ${crowd.ticks.length} ticks; hatched parts of a bar did not get through`,
        },
      },
      ...crowd.ticks.map((tick) => {
        const failed = tick.dropped + tick.blocked
        return h(
          'div',
          {
            class: 'crowd-bar',
            title: `Tick ${tick.tick + 1}: ${tick.delivered} delivered, ${failed} not`,
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
  if (firstSurge >= 0) {
    const width = (surgeTicks.length / crowd.ticks.length) * 100
    parts.push(
      h('div', {
        class: 'surge-band',
        textContent: 'surge',
        attrs: { style: `margin-left:${(firstSurge / crowd.ticks.length) * 100}%;width:${width}%` },
      }),
    )
  }
  parts.push(
    h('p', {
      class: 'note',
      textContent: `Targets in service: ${crowd.ticks[0]?.targetsInService ?? 0} at the start, ${crowd.peakTargetsInService} at the busiest, ${crowd.finalTargetsInService} at the end.`,
    }),
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
  const follow = h('div', { class: 'follow-buttons' })
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
      h('summary', { textContent: 'Tick by tick' }),
      h(
        'table',
        null,
        h(
          'tr',
          null,
          ...(
            [
              ['Tick', 13],
              ['Kites', 15],
              ['Timed out', 17],
              ['In service', 19],
              ['CPU', 18],
              ['Alarm', 18],
            ] as const
          ).map(([text, percent]) =>
            h('th', { textContent: text, attrs: { style: `width:${percent}%` } }),
          ),
        ),
        ...crowd.ticks.map((tick) =>
          h(
            'tr',
            { class: tick.surge ? 'in-surge' : '' },
            ...[
              tick.tick + 1,
              tick.demand,
              tick.dropped + tick.blocked,
              tick.launching > 0
                ? `${tick.targetsInService}+${tick.launching}`
                : tick.targetsInService,
              `${tick.cpuPercent}%`,
              ALARM_WORDS[tick.alarm],
            ].map((value) => h('td', { textContent: String(value) })),
          ),
        ),
      ),
      h('p', {
        class: 'note',
        textContent:
          'In service "4+2": four targets serving, two more launching. Alarm: which of the scaling policy’s CloudWatch alarms is in ALARM. Shaded rows are the surge.',
      }),
    ),
  )
  return parts
}

// ---------------------------------------------------------------------------
// Narrator
// ---------------------------------------------------------------------------

export function renderNarrator(state: GameState, onNext: () => void): HTMLElement[] {
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
      h('p', { textContent: step.text }),
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
    body.append(
      h(
        'li',
        { class: `trace-step ${passed ? 'pass' : 'fail'}` },
        h('span', { class: 'step-number', textContent: String(index + 1) }),
        h('span', { class: 'step-mark', textContent: passed ? '✓ pass' : '✗ stopped here' }),
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
      `${OUTCOME_LABELS[result.outcome]}${failed ? ` by ${CHECK_LABELS[failed.check]}` : ''}. `,
      kite.kind === 'hostile'
        ? good
          ? 'The attacker was stopped: that is what you want.'
          : 'The attacker got through.'
        : good
          ? 'The visitor was served.'
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
