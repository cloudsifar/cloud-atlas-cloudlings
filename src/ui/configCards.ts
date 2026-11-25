// Config cards: the encyclopedia-style label card that opens when the player
// clicks a cloud or a subnet. Only the options the engine models appear.
// A card never changes the scene itself: every control calls `actions.edit`
// with one of the pure edits from the game layer.

import {
  isPublicSubnet,
  PORT_OPTIONS,
  resourcesOfKind,
  type PolicyStatement,
  type PortOption,
  type Resource,
  type Route,
  type RouteTarget,
  type Scene,
  type SecurityGroup,
  type SecurityGroupPeer,
  type ServiceAction,
  LAUNCH_TICKS,
  REQUESTS_PER_TICK,
  ENGINE_PORT,
  describePort,
  type Ec2Instance,
} from '../engine'
import {
  addRoleStatement,
  addSecurityGroupRule,
  MAX_GROUP_SIZE,
  prefersReducedMotion,
  removeRoleStatement,
  removeRoute,
  removeSecurityGroupRule,
  setBlockPublicAccess,
  setDatabaseMultiAz,
  setGroupSettings,
  setGroupSubnets,
  setInstanceRole,
  setListener,
  setPublicRead,
  setRoute,
  setTargetRegistered,
  type GameState,
} from '../game'
import { button, dropdown, h, type Option } from './dom'

export type CardSubject = { kind: 'resource'; id: string } | { kind: 'subnet'; id: string }

export type CardActions = {
  edit(change: (scene: Scene) => Scene): void
  close(): void
  openFactCard(id: string): void
  /** Asks to send a cloud back to the palette tray (the screen may ask the player to confirm first). */
  remove(resourceId: string): void
  /** The cloud whose removal is waiting for the player to confirm a warning, if any. */
  pendingRemoval: string | null
  confirmRemove(resourceId: string): void
  cancelRemove(): void
  /** Card sections the narrator is pointing at right now (`<section>:<id>`, ADR 0008). */
  pulse: readonly string[]
}

/**
 * Makes a section heading pulse when the narrator is asking for a change in that
 * section, until the step is done. With reduced motion it glows without moving.
 */
function attention<T extends Element | null>(element: T, actions: CardActions, key: string): T {
  if (element && actions.pulse.includes(key)) {
    element.classList.add('pulse')
    if (prefersReducedMotion()) element.classList.add('still')
  }
  return element
}

const NAMED_RANGES: Option<string>[] = [
  { value: '10.0.0.0/16', label: 'The VPC (10.0.0.0/16)' },
  { value: '192.0.2.0/24', label: '192.0.2.0/24' },
  { value: '198.51.100.0/24', label: '198.51.100.0/24' },
  { value: '203.0.113.0/24', label: '203.0.113.0/24' },
]

/** The clouds wearing a security group, by name. */
function wearersOf(scene: Scene, groupId: string): string[] {
  return scene.resources
    .filter(
      (resource) => 'securityGroupIds' in resource && resource.securityGroupIds.includes(groupId),
    )
    .map((resource) => resource.name)
}

const listNames = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/**
 * A security group named as a source or destination says who wears it, so "alb-sg"
 * reads as "the load balancer's group" (ADR 0009).
 */
function describeGroup(scene: Scene, groupId: string): string {
  const name = scene.securityGroups.find((group) => group.id === groupId)?.name ?? '?'
  const wearers = wearersOf(scene, groupId)
  return `security group "${name}" (${wearers.length > 0 ? `worn by ${listNames(wearers)}` : 'worn by nothing yet'})`
}

function describePeer(scene: Scene, peer: SecurityGroupPeer): string {
  if (peer.kind === 'anywhere') return 'Anywhere (0.0.0.0/0)'
  if (peer.kind === 'cidr') return peer.cidr
  return describeGroup(scene, peer.securityGroupId)
}

/** Decodes a dropdown value ('anywhere', 'cidr:<range>' or 'sg:<id>') into a rule peer. */
const valueToPeer = (value: string): SecurityGroupPeer =>
  value === 'anywhere'
    ? { kind: 'anywhere' }
    : value.startsWith('cidr:')
      ? { kind: 'cidr', cidr: value.slice(5) }
      : { kind: 'security-group', securityGroupId: value.slice(3) }

function ruleList(
  items: { text: string; onRemove?: () => void; key: string }[],
  empty: string,
): HTMLElement {
  if (items.length === 0) return h('p', { class: 'empty', textContent: empty })
  return h(
    'ul',
    { class: 'rules' },
    ...items.map((item) =>
      h(
        'li',
        null,
        h('span', { textContent: item.text }),
        item.onRemove
          ? h('button', {
              type: 'button',
              class: 'remove',
              textContent: '×',
              onclick: item.onRemove,
              attrs: { 'aria-label': `Remove rule: ${item.text}`, 'data-focus-key': item.key },
            })
          : null,
      ),
    ),
  )
}

/** Pending choices in "add a rule" rows, kept across redraws so a dropdown does not snap back. */
const draft: Record<string, string> = {}
const pick = <T extends string>(key: string, fallback: T): T =>
  (draft[key] as T | undefined) ?? fallback

function securityGroupEditor(
  state: GameState,
  group: SecurityGroup,
  actions: CardActions,
): HTMLElement {
  const locked = state.level.lockedIds.includes(group.id)
  const section = h(
    'section',
    { class: 'card-section' },
    attention(
      h('h4', { textContent: `Security group "${group.name}"` }),
      actions,
      `security-group:${group.id}`,
    ),
  )
  // Who wears this group, and that a rule here applies to every one of them.
  const wearers = wearersOf(state.scene, group.id)
  section.append(
    h('p', {
      class: 'note worn-by',
      textContent:
        wearers.length === 0
          ? 'Worn by nothing yet.'
          : wearers.length === 1
            ? `Worn by ${wearers[0]}.`
            : `Worn by ${listNames(wearers)}. A rule you change here applies to every one of them.`,
    }),
  )
  if (locked) section.append(h('p', { class: 'locked-note', textContent: 'Locked in this level.' }))

  for (const direction of ['inbound', 'outbound'] as const) {
    const preposition = direction === 'inbound' ? 'from' : 'to'
    section.append(
      h('h5', {
        textContent:
          direction === 'inbound' ? 'Inbound rules (allow only)' : 'Outbound rules (allow only)',
      }),
      ruleList(
        group[direction].map((rule, index) => ({
          text: `${PORT_OPTIONS[rule.ports].label} ${preposition} ${describePeer(state.scene, rule.peer)}`,
          key: `${group.id}-${direction}-remove-${index}`,
          onRemove: locked
            ? undefined
            : () =>
                actions.edit((scene) => removeSecurityGroupRule(scene, group.id, direction, index)),
        })),
        direction === 'inbound'
          ? 'No inbound rules: everything inbound is refused.'
          : 'No outbound rules: nothing may be started from here.',
      ),
    )
    if (locked) continue

    const portKey = `${group.id}-${direction}-port`
    const peerKey = `${group.id}-${direction}-peer`
    const portOptions = (Object.keys(PORT_OPTIONS) as PortOption[]).map((option) => ({
      value: option,
      label: PORT_OPTIONS[option].label,
    }))
    const peerOptions: Option<string>[] = [
      { value: 'anywhere', label: 'Anywhere (0.0.0.0/0)' },
      ...NAMED_RANGES.map((range) => ({ value: `cidr:${range.value}`, label: range.label })),
      ...state.scene.securityGroups
        .filter((other) => other.id !== group.id)
        .map((other) => ({
          value: `sg:${other.id}`,
          label: describeGroup(state.scene, other.id).replace(/^s/, 'S'),
        })),
    ]
    section.append(
      h(
        'div',
        { class: 'add-row' },
        dropdown(
          'Port',
          portOptions,
          pick<PortOption>(portKey, 'https'),
          (value) => (draft[portKey] = value),
          portKey,
        ),
        dropdown(
          direction === 'inbound' ? 'Source' : 'Destination',
          peerOptions,
          pick(peerKey, 'anywhere'),
          (value) => (draft[peerKey] = value),
          peerKey,
        ),
        button(
          'Add rule',
          () =>
            actions.edit((scene) =>
              addSecurityGroupRule(scene, group.id, direction, {
                ports: pick<PortOption>(portKey, 'https'),
                peer: valueToPeer(pick(peerKey, 'anywhere')),
              }),
            ),
          `${group.id}-${direction}-add`,
        ),
      ),
    )
  }
  return section
}

const DESTINATION_LABELS: Record<Route['destination'], string> = {
  internet: 'Internet (0.0.0.0/0)',
  s3: 'S3 (prefix list)',
  dynamodb: 'DynamoDB (prefix list)',
}

function describeTarget(scene: Scene, target: RouteTarget): string {
  if (target.kind === 'internet-gateway') return 'Internet Gateway'
  if (target.kind === 'gateway-endpoint')
    return `${target.service === 's3' ? 'S3' : 'DynamoDB'} gateway endpoint`
  return (
    scene.resources.find((resource) => resource.id === target.natGatewayId)?.name ??
    'NAT Gateway (missing)'
  )
}

function subnetCard(state: GameState, subnetId: string, actions: CardActions): HTMLElement[] {
  const { scene, level } = state
  const subnet = scene.subnets.find((candidate) => candidate.id === subnetId)
  const table = scene.routeTables.find((candidate) => candidate.id === subnet?.routeTableId)
  const acl = scene.networkAcls.find((candidate) => candidate.id === subnet?.networkAclId)
  if (!subnet || !table || !acl) return []
  const locked = level.lockedIds.includes(table.id)
  const sharedWith = scene.subnets
    .filter((other) => other.routeTableId === table.id)
    .map((other) => other.name)

  // Routes on offer: to the Internet Gateway if attached, to any NAT Gateway, and to
  // the gateway endpoints this level allows. A gateway endpoint is not a cloud to
  // place: in AWS, too, it shows up as a prefix-list route in the route table.
  const internet = 'Internet (0.0.0.0/0)'
  const routeOptions: (Option<string> & { route: Route })[] = [
    ...resourcesOfKind(scene, 'internet-gateway').map(() => ({
      value: 'igw',
      label: `${internet} → Internet Gateway`,
      route: { destination: 'internet', target: { kind: 'internet-gateway' } } as Route,
    })),
    ...resourcesOfKind(scene, 'nat-gateway').map((nat) => ({
      value: `nat:${nat.id}`,
      label: `${internet} → ${nat.name}`,
      route: {
        destination: 'internet',
        target: { kind: 'nat-gateway', natGatewayId: nat.id },
      } as Route,
    })),
    ...(level.gatewayEndpoints ?? []).map((service) => ({
      value: `endpoint:${service}`,
      label: `${DESTINATION_LABELS[service]} → ${describeTarget(scene, { kind: 'gateway-endpoint', service })}`,
      route: { destination: service, target: { kind: 'gateway-endpoint', service } } as Route,
    })),
  ]
  const routeKey = `${table.id}-route`
  const chosen = pick(routeKey, routeOptions[0]?.value ?? '')

  const routes = h(
    'section',
    { class: 'card-section' },
    attention(
      h('h4', { textContent: `Route table "${table.name}"` }),
      actions,
      `route-table:${table.id}`,
    ),
    h('p', { class: 'note', textContent: `Used by: ${sharedWith.join(', ')}.` }),
    locked ? h('p', { class: 'locked-note', textContent: 'Locked in this level.' }) : null,
    ruleList(
      [
        { text: `The VPC (${scene.vpc.cidr}) → local   (always present)`, key: 'local' },
        ...table.routes.map((route) => ({
          text: `${DESTINATION_LABELS[route.destination]} → ${describeTarget(scene, route.target)}`,
          key: `${table.id}-remove-${route.destination}`,
          onRemove: locked
            ? undefined
            : () => actions.edit((current) => removeRoute(current, table.id, route.destination)),
        })),
      ],
      '',
    ),
    locked
      ? null
      : routeOptions.length === 0
        ? h('p', {
            class: 'note',
            textContent: 'There is nothing to route to yet. Attach an Internet Gateway first.',
          })
        : h(
            'div',
            { class: 'add-row' },
            dropdown('Route', routeOptions, chosen, (value) => (draft[routeKey] = value), routeKey),
            button(
              'Add route',
              () => {
                const value = pick(routeKey, routeOptions[0].value)
                const option = routeOptions.find((candidate) => candidate.value === value)
                if (option) actions.edit((current) => setRoute(current, table.id, option.route))
              },
              `${table.id}-add-route`,
            ),
          ),
  )

  const aclRules = (direction: 'inbound' | 'outbound') =>
    ruleList(
      [
        ...[...acl[direction]]
          .sort((first, second) => first.number - second.number)
          .map((rule) => ({
            text: `${rule.number}: ${rule.action} ${PORT_OPTIONS[rule.ports].label} ${direction === 'inbound' ? 'from' : 'to'} ${rule.peer.kind === 'anywhere' ? 'anywhere' : rule.peer.cidr}`,
            key: `${acl.id}-${direction}-${rule.number}`,
          })),
        { text: '*: deny everything else', key: `${acl.id}-${direction}-star` },
      ],
      '',
    )
  const nacl = h(
    'section',
    { class: 'card-section' },
    h('h4', { textContent: `Network ACL "${acl.name}"` }),
    h('p', {
      class: 'note',
      textContent:
        'Read lowest number first; the first match decides. Stateless: replies need their own rule.',
    }),
    h('h5', { textContent: 'Inbound' }),
    aclRules('inbound'),
    h('h5', { textContent: 'Outbound' }),
    aclRules('outbound'),
    button(
      'What is a network ACL?',
      () => actions.openFactCard('network-acl'),
      'fact-nacl',
      'link',
    ),
  )

  // The header carries the same tint as the subnet in the sky: public or private, by its routes.
  const header = cardHeader(
    subnet.name,
    `${isPublicSubnet(scene, subnet) ? 'Public' : 'Private'} subnet · Availability Zone ${subnet.availabilityZone} · ${subnet.cidr}`,
    'route-table',
    actions,
  )
  header.classList.add(isPublicSubnet(scene, subnet) ? 'subnet-public' : 'subnet-private')
  return [header, routes, nacl]
}

function cardHeader(
  title: string,
  subtitle: string,
  factCardId: string,
  actions: CardActions,
): HTMLElement {
  return h(
    'header',
    { class: 'card-header' },
    h(
      'div',
      null,
      h('h3', { textContent: title }),
      h('p', { class: 'subtitle', textContent: subtitle }),
    ),
    h('button', {
      type: 'button',
      class: 'close',
      textContent: '×',
      onclick: actions.close,
      attrs: { 'aria-label': 'Close card', 'data-focus-key': 'card-close' },
    }),
    button('What is this?', () => actions.openFactCard(factCardId), 'card-fact', 'link'),
  )
}

const KIND_SUBTITLE: Record<Resource['kind'], string> = {
  'internet-gateway': 'The gate between the VPC and the internet',
  'nat-gateway': 'Outbound-only door for private subnets',
  'load-balancer': 'The front door: shares requests between targets',
  'ec2-instance': 'A virtual server',
  'auto-scaling-group': 'A fleet of instances that grows and shrinks',
  's3-bucket': 'Object storage, outside the VPC',
  'iam-role': 'Permissions a resource can wear',
  'rds-database': 'A managed relational database',
}

function resourceCard(state: GameState, resource: Resource, actions: CardActions): HTMLElement[] {
  const { scene, level } = state
  const locked = level.lockedIds.includes(resource.id)
  const subnetName = (id: string) => scene.subnets.find((subnet) => subnet.id === id)?.name ?? '?'
  const groups = ('securityGroupIds' in resource ? resource.securityGroupIds : [])
    .map((id) => scene.securityGroups.find((group) => group.id === id))
    .filter((group): group is SecurityGroup => group !== undefined)

  const parts: HTMLElement[] = [
    cardHeader(resource.name, KIND_SUBTITLE[resource.kind], resource.kind, actions),
  ]
  if (locked)
    parts.push(h('p', { class: 'locked-note', textContent: 'This cloud is locked in this level.' }))
  const body = h('section', { class: 'card-section' })
  parts.push(body)

  switch (resource.kind) {
    case 'internet-gateway':
      body.append(
        h('p', {
          textContent:
            'Attached to the VPC. A subnet becomes public when its route table sends Internet (0.0.0.0/0) here: click a subnet to edit its routes.',
        }),
      )
      break
    case 'nat-gateway':
      body.append(
        h('p', {
          textContent: `Sits in ${subnetName(resource.subnetId)}. Private subnets that route Internet (0.0.0.0/0) to it can start connections out. Nothing can come in through it.`,
        }),
      )
      break
    case 'load-balancer': {
      const instances = [
        ...resourcesOfKind(scene, 'ec2-instance'),
        ...resourcesOfKind(scene, 'auto-scaling-group'),
      ]
      const listener = dropdown(
        'Listener',
        [
          { value: 'http', label: 'HTTP 80' },
          { value: 'https', label: 'HTTPS 443' },
        ],
        resource.listener,
        (value) => actions.edit((current) => setListener(current, resource.id, value)),
        'listener',
        locked,
      )
      attention(listener.firstElementChild, actions, `listener:${resource.id}`)
      // A link of its own, beside the field rather than inside its label.
      const listenerFact = button(
        'What is a listener?',
        () => actions.openFactCard('concept-listener'),
        'listener-fact',
        'link',
      )
      body.append(
        h('p', {
          class: 'note',
          textContent: `Internet-facing · nodes in ${resource.subnetIds.map(subnetName).join(' and ') || 'no subnets'}`,
        }),
        listener,
        listenerFact,
        attention(
          h('h5', { textContent: 'Targets (receive requests on HTTP 80)' }),
          actions,
          `targets:${resource.id}`,
        ),
        ...(instances.length === 0
          ? [h('p', { class: 'empty', textContent: 'There are no instances to target.' })]
          : []),
        ...instances.map((instance) => {
          const box = h('input', {
            type: 'checkbox',
            checked: resource.targetIds.includes(instance.id),
            disabled: locked,
            attrs: { 'data-focus-key': `target-${instance.id}` },
          })
          box.onchange = () =>
            actions.edit((current) =>
              setTargetRegistered(current, resource.id, instance.id, box.checked),
            )
          return h(
            'label',
            { class: 'check' },
            box,
            instance.kind === 'ec2-instance'
              ? `${instance.name} (${subnetName(instance.subnetId)})`
              : `${instance.name} (Auto Scaling group: all its instances)`,
          )
        }),
      )
      break
    }
    case 'ec2-instance': {
      const roles = resourcesOfKind(scene, 'iam-role')
      const roleField = dropdown(
        'IAM role',
        [
          { value: '', label: 'None' },
          ...roles.map((role) => ({ value: role.id, label: role.name })),
        ],
        resource.roleId ?? '',
        (value) =>
          actions.edit((current) =>
            setInstanceRole(current, resource.id, value === '' ? null : value),
          ),
        'role',
        locked,
      )
      attention(roleField.firstElementChild, actions, `instance-role:${resource.id}`)
      body.append(
        h('p', {
          class: 'note',
          textContent: `In ${subnetName(resource.subnetId)} · size ${resource.size} · private address only`,
        }),
        roleField,
      )
      break
    }
    case 'auto-scaling-group': {
      // Desired capacity always lies between the minimum and the maximum, as in AWS;
      // setGroupSettings keeps it there when a limit moves.
      const stepper = (
        label: string,
        field: 'min' | 'desired' | 'max',
        value: number,
        lowest: number,
        highest: number,
      ) =>
        h(
          'div',
          { class: 'stepper' },
          h('span', { textContent: label }),
          button(
            '−',
            () =>
              actions.edit((current) =>
                setGroupSettings(current, resource.id, { [field]: value - 1 }),
              ),
            `${field}-down`,
            '',
            locked || value <= lowest,
          ),
          h('output', {
            textContent: String(value),
            attrs: { 'aria-label': `${label}: ${value}` },
          }),
          button(
            '+',
            () =>
              actions.edit((current) =>
                setGroupSettings(current, resource.id, { [field]: value + 1 }),
              ),
            `${field}-up`,
            '',
            locked || value >= highest,
          ),
        )
      const sizes: Option<Ec2Instance['size']>[] = (['small', 'medium', 'large'] as const).map(
        (size) => ({
          value: size,
          label: `${size[0]!.toUpperCase()}${size.slice(1)}: room for ${REQUESTS_PER_TICK[size]} kites`,
        }),
      )
      // A group that is not a load balancer target gets no kites, whatever its settings:
      // say so at the top of its card (ADR 0012).
      const attached = resourcesOfKind(scene, 'load-balancer').some((loadBalancer) =>
        loadBalancer.targetIds.includes(resource.id),
      )
      if (!attached) {
        body.append(
          h('p', {
            class: 'card-warning',
            attrs: { role: 'status' },
            textContent:
              'No load balancer sends kites to this group yet, so its instances serve nobody. Click the load balancer and tick this group as a target.',
          }),
        )
      }
      const scalingField = dropdown(
        'Scaling policy (target tracking)',
        [
          { value: '', label: 'None: stay at the minimum' },
          ...[40, 50, 60, 70, 80].map((percent) => ({
            value: String(percent),
            label: `Keep average CPU near ${percent}%`,
          })),
        ],
        resource.scaling ? String(resource.scaling.targetCpuPercent) : '',
        (value) =>
          actions.edit((current) =>
            setGroupSettings(current, resource.id, {
              scaling: value === '' ? null : { targetCpuPercent: Number(value) },
            }),
          ),
        'scaling',
        locked,
      )
      attention(scalingField.firstElementChild, actions, `group-scaling:${resource.id}`)
      // Which private subnets, and so which Availability Zones, the fleet runs in (ADR 0014).
      const privateSubnets = scene.subnets.filter((subnet) => subnet.band === 'mid')
      const subnetBoxes = privateSubnets.map((subnet) => {
        const on = resource.subnetIds.includes(subnet.id)
        const box = h('input', {
          type: 'checkbox',
          checked: on,
          // A group always keeps at least one subnet.
          disabled: locked || (on && resource.subnetIds.length === 1),
          attrs: { 'data-focus-key': `group-subnet-${subnet.id}` },
        })
        box.onchange = () =>
          actions.edit((current) =>
            setGroupSubnets(
              current,
              resource.id,
              box.checked
                ? [...resource.subnetIds, subnet.id]
                : resource.subnetIds.filter((id) => id !== subnet.id),
            ),
          )
        return h(
          'label',
          { class: 'check' },
          box,
          `${subnet.name} (Availability Zone ${subnet.availabilityZone.toUpperCase()})`,
        )
      })
      const zones = new Set(
        resource.subnetIds.map(
          (id) => scene.subnets.find((subnet) => subnet.id === id)?.availabilityZone,
        ),
      )
      body.append(
        attention(
          h('h5', { textContent: 'Subnets (and so Availability Zones)' }),
          actions,
          `group-subnets:${resource.id}`,
        ),
        ...subnetBoxes,
        h('p', {
          class: 'note',
          textContent:
            zones.size > 1
              ? 'Identical instances, spread evenly across these zones. If one zone fails, the group launches replacements in the other.'
              : 'Every instance is in one Availability Zone. If that zone fails, the group has nowhere else to launch.',
        }),
        dropdown(
          'Instance size',
          sizes,
          resource.size,
          (size) => actions.edit((current) => setGroupSettings(current, resource.id, { size })),
          'size',
          locked,
        ),
        stepper('Minimum instances', 'min', resource.min, 1, MAX_GROUP_SIZE),
        stepper('Desired (to start with)', 'desired', resource.desired, resource.min, resource.max),
        stepper('Maximum instances', 'max', resource.max, 1, MAX_GROUP_SIZE),
        scalingField,
        h('p', {
          class: 'note',
          textContent: `With a policy, CloudWatch alarms watch the fleet’s CPU. When it rises above the target, the group launches enough instances to bring it back down; they take ${LAUNCH_TICKS} minutes to start serving. When it stays below the target, the group removes instances, at most half the fleet at a time.`,
        }),
      )
      break
    }
    case 'rds-database': {
      // An RDS database: where it runs, its standby, and who may connect (ADR 0014).
      const zoneOf = (id: string) =>
        scene.subnets.find((subnet) => subnet.id === id)?.availabilityZone.toUpperCase() ?? '?'
      const primaryZone = zoneOf(resource.primarySubnetId)
      const standbySubnet = resource.subnetIds.find((id) => zoneOf(id) !== primaryZone)
      const multiAzBox = h('input', {
        type: 'checkbox',
        checked: resource.multiAz,
        disabled: locked || standbySubnet === undefined,
        attrs: { 'data-focus-key': 'multi-az' },
      })
      multiAzBox.onchange = () =>
        actions.edit((current) => setDatabaseMultiAz(current, resource.id, multiAzBox.checked))
      const engine = resource.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'
      body.append(
        h('p', {
          class: 'note',
          textContent: `${engine}, listening on ${describePort(ENGINE_PORT[resource.engine])} · DB subnet group: ${resource.subnetIds.map(subnetName).join(' and ')}`,
        }),
        h('p', {
          class: 'note',
          textContent: resource.multiAz
            ? `Primary in AZ ${primaryZone} (${subnetName(resource.primarySubnetId)}); standby in AZ ${standbySubnet ? zoneOf(standbySubnet) : '?'}, kept in step with every write. The standby answers nothing until it takes over.`
            : `Runs in AZ ${primaryZone} only (${subnetName(resource.primarySubnetId)}). If that zone fails, the database is down.`,
        }),
        attention(
          h('label', { class: 'check' }, multiAzBox, 'Multi-AZ: a standby in another zone'),
          actions,
          `database-multi-az:${resource.id}`,
        ),
        h('p', {
          class: 'note',
          textContent:
            'If the primary’s zone fails, RDS fails over to the standby by itself, typically within a minute or two (2 minutes here). The database keeps its address, so the application reconnects to the same name. A Multi-AZ database costs about twice as much.',
        }),
      )
      break
    }
    case 's3-bucket': {
      const blockBox = h('input', {
        type: 'checkbox',
        checked: resource.blockPublicAccess,
        disabled: locked,
        attrs: { 'data-focus-key': 'bpa' },
      })
      blockBox.onchange = () =>
        actions.edit((current) => setBlockPublicAccess(current, resource.id, blockBox.checked))
      const isPublicRead = resource.policy.some(
        (statement) => statement.effect === 'allow' && statement.principal.kind === 'everyone',
      )
      const publicBox = h('input', {
        type: 'checkbox',
        checked: isPublicRead,
        disabled: locked,
        attrs: { 'data-focus-key': 'public-read' },
      })
      publicBox.onchange = () =>
        actions.edit((current) => setPublicRead(current, resource.id, publicBox.checked))
      body.append(
        h('p', {
          class: 'note',
          textContent: `Holds: ${resource.dataClass === 'sensitive' ? 'sensitive data' : 'public content (a website)'} · Encrypted at rest: always (SSE-S3)`,
        }),
        h('label', { class: 'check' }, blockBox, 'Block Public Access'),
        h('label', { class: 'check' }, publicBox, 'Bucket policy: allow s3:Read to everyone'),
        h('p', {
          class: 'note',
          textContent:
            'The bucket is public only if Block Public Access is off and the policy grants everyone.',
        }),
      )
      break
    }
    case 'iam-role': {
      const buckets = resourcesOfKind(scene, 's3-bucket')
      const actionOptions: Option<ServiceAction>[] = (
        ['s3:Read', 's3:Write', 's3:Delete'] as const
      ).map((action) => ({ value: action, label: action }))
      const resourceOptions: Option<string>[] = [
        ...buckets.map((bucket) => ({ value: bucket.id, label: bucket.name })),
        { value: '*', label: '* (every resource)' },
      ]
      const nameOf = (id: string) =>
        id === '*'
          ? 'every resource (*)'
          : (scene.resources.find((candidate) => candidate.id === id)?.name ?? id)
      const key = (part: string) => `${resource.id}-statement-${part}`
      const statement = (): PolicyStatement => ({
        effect: pick<PolicyStatement['effect']>(key('effect'), 'allow'),
        actions: [pick<ServiceAction>(key('action'), 's3:Read')],
        resource: pick(key('resource'), resourceOptions[0]?.value ?? '*'),
      })
      body.append(
        attention(
          h('h5', { textContent: 'Statements (everything else is denied)' }),
          actions,
          `role-statements:${resource.id}`,
        ),
        ruleList(
          resource.statements.map((item, index) => ({
            text: `${item.effect === 'allow' ? 'Allow' : 'Deny'} ${item.actions.join(', ')} on ${nameOf(item.resource)}`,
            key: key(`remove-${index}`),
            onRemove: locked
              ? undefined
              : () => actions.edit((current) => removeRoleStatement(current, resource.id, index)),
          })),
          'No statements: this role allows nothing.',
        ),
      )
      if (!locked) {
        body.append(
          h(
            'div',
            { class: 'add-row' },
            dropdown(
              'Effect',
              [
                { value: 'allow', label: 'Allow' },
                { value: 'deny', label: 'Deny' },
              ],
              statement().effect,
              (value) => (draft[key('effect')] = value),
              key('effect'),
            ),
            dropdown(
              'Action',
              actionOptions,
              statement().actions[0] ?? 's3:Read',
              (value) => (draft[key('action')] = value),
              key('action'),
            ),
            dropdown(
              'On',
              resourceOptions,
              statement().resource,
              (value) => (draft[key('resource')] = value),
              key('resource'),
            ),
            button(
              'Add statement',
              () => actions.edit((current) => addRoleStatement(current, resource.id, statement())),
              key('add'),
            ),
          ),
        )
      }
      body.append(
        attention(h('h5', { textContent: 'Worn by' }), actions, `role-wearers:${resource.id}`),
      )
      for (const instance of resourcesOfKind(scene, 'ec2-instance')) {
        const instanceLocked = level.lockedIds.includes(instance.id)
        const box = h('input', {
          type: 'checkbox',
          checked: instance.roleId === resource.id,
          disabled: instanceLocked,
          attrs: { 'data-focus-key': `wear-${instance.id}` },
        })
        box.onchange = () =>
          actions.edit((current) =>
            setInstanceRole(current, instance.id, box.checked ? resource.id : null),
          )
        body.append(h('label', { class: 'check' }, box, instance.name))
      }
      break
    }
  }

  for (const group of groups) parts.push(securityGroupEditor(state, group, actions))
  if (groups.length > 0)
    parts.push(
      button(
        'What is a security group?',
        () => actions.openFactCard('security-group'),
        'fact-sg',
        'link',
      ),
    )

  const fromPalette = level.palette.some((entry) => entry.resource.id === resource.id)
  const removable = fromPalette || (level.removableIds ?? []).includes(resource.id)
  if (removable && !locked) {
    const warning = level.removalWarnings?.[resource.id]
    parts.push(
      warning && actions.pendingRemoval === resource.id
        ? h(
            'footer',
            { class: 'card-footer removal-warning', attrs: { role: 'alert' } },
            h('p', { textContent: warning }),
            h(
              'div',
              { class: 'button-row' },
              button('Keep it', actions.cancelRemove, 'card-remove-keep', 'primary'),
              button(
                'Remove anyway',
                () => actions.confirmRemove(resource.id),
                'card-remove-confirm',
                'quiet',
              ),
            ),
          )
        : h(
            'footer',
            { class: 'card-footer' },
            button(
              'Remove from the sky',
              () => actions.remove(resource.id),
              'card-remove',
              'quiet',
            ),
          ),
    )
  }
  return parts
}

/** Builds the card for a subject, or null if the subject no longer exists. */
export function renderConfigCard(
  subject: CardSubject,
  state: GameState,
  actions: CardActions,
): HTMLElement | null {
  let parts: HTMLElement[] = []
  if (subject.kind === 'subnet') parts = subnetCard(state, subject.id, actions)
  else {
    const resource = state.scene.resources.find((candidate) => candidate.id === subject.id)
    if (resource) parts = resourceCard(state, resource, actions)
  }
  if (parts.length === 0) return null
  return h(
    'div',
    { class: 'config-card', attrs: { role: 'dialog', 'aria-label': 'Configuration' } },
    ...parts,
  )
}
