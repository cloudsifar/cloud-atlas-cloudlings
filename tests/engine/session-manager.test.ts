// Shell access to an instance: SSH to a public address, SSH through a bastion host, and
// AWS Systems Manager Session Manager (docs/ENGINE.md, section 18; ADR 0020).
//
// AWS documentation this file is based on:
// - Session Manager needs no open inbound ports, no bastion hosts and no SSH keys.
//   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html
// - The managed nodes must allow HTTPS (443) out to the ec2messages, ssm and
//   ssmmessages endpoints, and the instance profile's role must grant the permissions
//   in AmazonSSMManagedInstanceCore (here, ssm:ManagedInstance).
//   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html
// - Session Manager needs no public IP address for the instance; from a private subnet
//   the agent reaches the endpoints through a NAT Gateway (or interface endpoints).
//   https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/connect-to-an-amazon-ec2-instance-by-using-session-manager.html
//   https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html
// - A bastion host sits in a public subnet with a public address; its security group
//   allows SSH from the administrators' addresses, and the private instances allow SSH
//   from the bastion's security group.
//   https://docs.aws.amazon.com/whitepapers/latest/aws-overview/networking-services.html
//   https://aws.amazon.com/solutions/implementations/linux-bastion/
// - Network ACLs are stateless: return traffic must be allowed explicitly, in both the
//   instance's subnet and the NAT Gateway's.
//   https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html
//   https://docs.aws.amazon.com/vpc/latest/userguide/nacl-rules.html

import { describe, expect, it } from 'vitest'
import {
  coinsFor,
  evaluateFlow,
  evaluatePredicate,
  failingStep,
  scoreScene,
  validateScene,
  type Ec2Instance,
  type Flow,
  type FlowRun,
  type NetworkAcl,
  type Predicate,
  type Scene,
  type SessionManager,
} from '../../src/engine'
import { byId, sceneWith } from './fixtures'

const OPERATOR_IP = '203.0.113.25'
const COAST_IP = '192.0.2.77'
const PROBE_IP = '192.0.2.150'

const SESSION_MANAGER: SessionManager = {
  kind: 'session-manager',
  id: 'ssm',
  name: 'Session Manager',
}

const BASTION: Ec2Instance = {
  kind: 'ec2-instance',
  id: 'bastion',
  name: 'Bastion host',
  subnetId: 'public-a',
  securityGroupIds: ['sg-bastion'],
  roleId: null,
  size: 'small',
  healthy: true,
  publicAddress: true,
}

/** The working scene with a bastion host set up the careful way: SSH from one address. */
function withBastion(change: (scene: Scene) => void = () => {}): Scene {
  return sceneWith((scene) => {
    scene.resources.push(structuredClone(BASTION))
    scene.securityGroups.push({
      id: 'sg-bastion',
      name: 'bastion-sg',
      inbound: [{ ports: 'ssh', peer: { kind: 'cidr', cidr: `${OPERATOR_IP}/32` } }],
      outbound: [{ ports: 'all', peer: { kind: 'anywhere' } }],
    })
    byId(scene.securityGroups, 'sg-app').inbound.push({
      ports: 'ssh',
      peer: { kind: 'security-group', securityGroupId: 'sg-bastion' },
    })
    change(scene)
  })
}

/** The working scene with Session Manager placed and the role allowed to register. */
function withSessionManager(change: (scene: Scene) => void = () => {}): Scene {
  return sceneWith((scene) => {
    scene.resources.push(structuredClone(SESSION_MANAGER))
    const role = byId(scene.resources, 'app-role')
    if (role.kind === 'iam-role')
      role.statements.push({ effect: 'allow', actions: ['ssm:ManagedInstance'], resource: 'ssm' })
    change(scene)
  })
}

function operator(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 'operator',
    source: { kind: 'internet', ip: OPERATOR_IP },
    destination: { kind: 'resource', id: 'app-a' },
    port: 22,
    payload: 'clean',
    intent: 'legitimate',
    shell: { jumpHostId: 'bastion' },
    ...overrides,
  }
}

function probe(destinationId: string, ip = PROBE_IP): Flow {
  return {
    id: 'red-probe',
    source: { kind: 'internet', ip },
    destination: { kind: 'resource', id: destinationId },
    port: 22,
    payload: 'clean',
    intent: 'hostile',
  }
}

/** A custom network ACL for the public subnets, like Level 7's edge: HTTPS in, replies out. */
function edgeAcl(extra: Partial<Pick<NetworkAcl, 'inbound' | 'outbound'>> = {}): NetworkAcl {
  return {
    id: 'edge-acl',
    name: 'edge-acl',
    inbound: [
      { number: 100, action: 'allow', ports: 'https', peer: { kind: 'anywhere' } },
      {
        number: 200,
        action: 'allow',
        ports: 'ephemeral',
        peer: { kind: 'cidr', cidr: '10.0.0.0/16' },
      },
      ...(extra.inbound ?? []),
    ],
    outbound: [
      { number: 100, action: 'allow', ports: 'ephemeral', peer: { kind: 'anywhere' } },
      { number: 200, action: 'allow', ports: 'http', peer: { kind: 'cidr', cidr: '10.0.0.0/16' } },
      ...(extra.outbound ?? []),
    ],
  }
}

function useEdgeAcl(scene: Scene, acl: NetworkAcl): void {
  scene.networkAcls.push(acl)
  for (const subnet of scene.subnets) if (subnet.band === 'low') subnet.networkAclId = acl.id
}

const stoppedBy = (scene: Scene, flow: Flow) => failingStep(evaluateFlow(scene, flow))?.check

describe('a kite aimed at an instance', () => {
  it('cannot reach an instance with only a private address, on SSH or any port', () => {
    const result = evaluateFlow(
      sceneWith(() => {}),
      probe('app-a'),
    )
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.ruleRef).toBe('no public address')
  })

  it('reaches SSH on a bastion host only from the address its security group allows', () => {
    const scene = withBastion()
    expect(evaluateFlow(scene, probe('bastion')).outcome).toBe('blocked')
    expect(stoppedBy(scene, probe('bastion'))).toBe('security-group')
    const fromOperator = evaluateFlow(scene, {
      ...probe('bastion', OPERATOR_IP),
      intent: 'legitimate',
    })
    expect(fromOperator.outcome).toBe('delivered')
  })

  it('is a breach when a hostile kite finds SSH open to anywhere', () => {
    const scene = withBastion((draft) => {
      byId(draft.securityGroups, 'sg-bastion').inbound = [
        { ports: 'ssh', peer: { kind: 'anywhere' } },
      ]
    })
    expect(evaluateFlow(scene, probe('bastion')).outcome).toBe('breach')
  })

  it('cannot reach a public address in a subnet with no route to the Internet Gateway', () => {
    const scene = withBastion((draft) => {
      const bastion = byId(draft.resources, 'bastion')
      if (bastion.kind === 'ec2-instance') bastion.subnetId = 'private-a'
    })
    expect(stoppedBy(scene, { ...probe('bastion', OPERATOR_IP), intent: 'legitimate' })).toBe(
      'route',
    )
  })
})

describe('SSH through a bastion host', () => {
  it('gives the operator a shell on the private instance: two connections, both allowed', () => {
    const result = evaluateFlow(withBastion(), operator())
    expect(result.outcome).toBe('delivered')
    // The bastion's own group lets it out, then the instance's group lets the bastion in.
    const groups = result.trace.filter((step) => step.check === 'security-group')
    expect(groups.map((step) => step.at)).toEqual([
      { kind: 'resource', id: 'bastion' },
      { kind: 'resource', id: 'bastion' },
      { kind: 'resource', id: 'app-a' },
    ])
  })

  it('has no way in without a bastion host', () => {
    const result = evaluateFlow(
      sceneWith(() => {}),
      operator(),
    )
    expect(failingStep(result)?.ruleRef).toBe('no public address')
  })

  it('stops at the private instance unless its group lets the bastion in', () => {
    const scene = withBastion((draft) => {
      byId(draft.securityGroups, 'sg-app').inbound.pop()
    })
    const failed = failingStep(evaluateFlow(scene, operator()))
    expect(failed?.check).toBe('security-group')
    expect(failed?.at).toEqual({ kind: 'resource', id: 'app-a' })
  })

  it('locks the operator out when their address changes', () => {
    expect(stoppedBy(withBastion(), operator({ source: { kind: 'internet', ip: COAST_IP } }))).toBe(
      'security-group',
    )
  })

  it('needs the edge network ACL to allow SSH in, SSH out to the VPC, and the replies', () => {
    const closed = withBastion((draft) => useEdgeAcl(draft, edgeAcl()))
    expect(stoppedBy(closed, operator())).toBe('nacl')
    const inOnly = withBastion((draft) =>
      useEdgeAcl(
        draft,
        edgeAcl({
          inbound: [
            {
              number: 110,
              action: 'allow',
              ports: 'ssh',
              peer: { kind: 'cidr', cidr: `${OPERATOR_IP}/32` },
            },
          ],
        }),
      ),
    )
    // Stateless: the hop to the web server is a new connection out of the public subnet.
    const failed = failingStep(evaluateFlow(inOnly, operator()))
    expect(failed?.check).toBe('nacl')
    expect(failed?.at).toEqual({ kind: 'subnet', id: 'public-a' })
    const both = withBastion((draft) =>
      useEdgeAcl(
        draft,
        edgeAcl({
          inbound: [
            {
              number: 110,
              action: 'allow',
              ports: 'ssh',
              peer: { kind: 'cidr', cidr: `${OPERATOR_IP}/32` },
            },
          ],
          outbound: [
            {
              number: 210,
              action: 'allow',
              ports: 'ssh',
              peer: { kind: 'cidr', cidr: '10.0.0.0/16' },
            },
          ],
        }),
      ),
    )
    expect(evaluateFlow(both, operator()).outcome).toBe('delivered')
  })
})

describe('a session through Session Manager', () => {
  it('opens a shell with no inbound rule for SSH anywhere', () => {
    const scene = withSessionManager()
    expect(
      scene.securityGroups.every((group) => group.inbound.every((rule) => rule.ports !== 'ssh')),
    ).toBe(true)
    const result = evaluateFlow(scene, operator())
    expect(result.outcome).toBe('delivered')
    // The operator's request comes down from Session Manager; nothing reaches the
    // instance from the internet.
    expect(result.trace[0]?.at).toEqual({ kind: 'resource', id: 'ssm' })
    expect(result.trace.some((step) => step.at.kind === 'vpc')).toBe(false)
  })

  it('is used instead of SSH once Session Manager is in the sky', () => {
    const scene = withBastion((draft) => {
      draft.resources.push(structuredClone(SESSION_MANAGER))
    })
    // The role cannot register yet, so the session fails, even though SSH would work.
    expect(stoppedBy(scene, operator())).toBe('iam')
  })

  it('reaches only managed instances: the role must allow ssm:ManagedInstance', () => {
    const noPermission = sceneWith((scene) => {
      scene.resources.push(structuredClone(SESSION_MANAGER))
    })
    expect(stoppedBy(noPermission, operator())).toBe('iam')
    const noRole = withSessionManager((scene) => {
      const instance = byId(scene.resources, 'app-a')
      if (instance.kind === 'ec2-instance') instance.roleId = null
    })
    expect(failingStep(evaluateFlow(noRole, operator()))?.ruleRef).toBe('no IAM role')
    const denied = withSessionManager((scene) => {
      const role = byId(scene.resources, 'app-role')
      if (role.kind === 'iam-role')
        role.statements.push({ effect: 'deny', actions: ['ssm:ManagedInstance'], resource: '*' })
    })
    expect(failingStep(evaluateFlow(denied, operator()))?.ruleRef).toContain('explicit deny')
  })

  it('needs a way out to the Systems Manager endpoints: a gateway endpoint will not do', () => {
    const scene = withSessionManager((draft) => {
      byId(draft.routeTables, 'rt-private').routes = [
        { destination: 's3', target: { kind: 'gateway-endpoint', service: 's3' } },
      ]
    })
    const failed = failingStep(evaluateFlow(scene, operator()))
    expect(failed?.check).toBe('route')
    expect(failed?.leg).toBe('backend-request')
  })

  it('needs HTTPS out of the instance security group', () => {
    const scene = withSessionManager((draft) => {
      byId(draft.securityGroups, 'sg-app').outbound = [
        { ports: 'mysql', peer: { kind: 'anywhere' } },
      ]
    })
    expect(stoppedBy(scene, operator())).toBe('security-group')
  })

  it('crosses the NAT Gateway subnet network ACL both ways', () => {
    const closed = withSessionManager((draft) => useEdgeAcl(draft, edgeAcl()))
    // In on 443 from the instance is allowed; out on 443 to the endpoints is not.
    const outbound = failingStep(evaluateFlow(closed, operator()))
    expect(outbound?.check).toBe('nacl')
    expect(outbound?.leg).toBe('backend-request')
    const outOnly = withSessionManager((draft) =>
      useEdgeAcl(
        draft,
        edgeAcl({
          outbound: [{ number: 300, action: 'allow', ports: 'https', peer: { kind: 'anywhere' } }],
        }),
      ),
    )
    // The endpoints' replies come back on an ephemeral port from outside the VPC.
    const reply = failingStep(evaluateFlow(outOnly, operator()))
    expect(reply?.check).toBe('nacl')
    expect(reply?.leg).toBe('backend-response')
    const both = withSessionManager((draft) =>
      useEdgeAcl(
        draft,
        edgeAcl({
          inbound: [
            { number: 300, action: 'allow', ports: 'ephemeral', peer: { kind: 'anywhere' } },
          ],
          outbound: [{ number: 300, action: 'allow', ports: 'https', peer: { kind: 'anywhere' } }],
        }),
      ),
    )
    expect(evaluateFlow(both, operator()).outcome).toBe('delivered')
  })
})

describe('Level 9 predicates', () => {
  const runs = (scene: Scene, flows: Flow[]): FlowRun[] =>
    flows.map((flow) => ({ flow, result: evaluateFlow(scene, flow) }))

  it('session-opened holds only for a shell through Session Manager', () => {
    const predicate: Predicate = { kind: 'session-opened', flows: { flowIds: ['operator'] } }
    const bySsh = withBastion()
    expect(evaluatePredicate(bySsh, runs(bySsh, [operator()]), predicate)).toBe(false)
    const bySession = withSessionManager()
    expect(evaluatePredicate(bySession, runs(bySession, [operator()]), predicate)).toBe(true)
  })

  it('security-groups-closed-to counts "All traffic" as letting SSH in', () => {
    const predicate = { kind: 'security-groups-closed-to', ports: 'ssh' } as const
    expect(
      evaluatePredicate(
        sceneWith(() => {}),
        [],
        predicate,
      ),
    ).toBe(true)
    expect(evaluatePredicate(withBastion(), [], predicate)).toBe(false)
    const allTraffic = sceneWith((scene) => {
      byId(scene.securityGroups, 'sg-app').inbound.push({
        ports: 'all',
        peer: { kind: 'anywhere' },
      })
    })
    expect(evaluatePredicate(allTraffic, [], predicate)).toBe(false)
  })

  it('no-rule-names finds SSH in a network ACL as well as a security group', () => {
    const predicate = { kind: 'no-rule-names', ports: 'ssh' } as const
    expect(
      evaluatePredicate(
        sceneWith(() => {}),
        [],
        predicate,
      ),
    ).toBe(true)
    const inAcl = sceneWith((scene) =>
      useEdgeAcl(
        scene,
        edgeAcl({
          outbound: [
            {
              number: 210,
              action: 'allow',
              ports: 'ssh',
              peer: { kind: 'cidr', cidr: '10.0.0.0/16' },
            },
          ],
        }),
      ),
    )
    expect(evaluatePredicate(inAcl, [], predicate)).toBe(false)
  })

  it('all-of holds only when every part does', () => {
    const scene = withSessionManager()
    const yes = { kind: 'resource-exists', resourceId: 'ssm' } as const
    const no = { kind: 'resource-exists', resourceId: 'bastion' } as const
    expect(evaluatePredicate(scene, [], { kind: 'all-of', predicates: [yes] })).toBe(true)
    expect(evaluatePredicate(scene, [], { kind: 'all-of', predicates: [yes, no] })).toBe(false)
  })
})

describe('scoring, cost and validation', () => {
  it('does not call a bastion host’s rule for one address too wide: it faces the internet', () => {
    const scene = withBastion()
    const findings = scoreScene(
      scene,
      [{ flow: operator(), result: evaluateFlow(scene, operator()) }],
      [],
    )
    expect(findings.filter((finding) => finding.subjectId === 'sg-bastion')).toEqual([])
  })

  it('charges nothing for Session Manager, and a bastion host like any instance', () => {
    expect(coinsFor(SESSION_MANAGER)).toBe(0)
    expect(coinsFor(BASTION)).toBe(2)
  })

  it('allows one Session Manager per scene', () => {
    const scene = withSessionManager((draft) => {
      draft.resources.push({ ...SESSION_MANAGER, id: 'ssm-2' })
    })
    expect(validateScene(scene).length).toBeGreaterThan(0)
  })
})
