# 0004 — Engine model choices that refine the brief's starting types

The brief's `Flow`/`FlowResult` types were "a starting point". These refinements keep
the verdict-plus-trace shape.

1. **No `identity` on a flow.** No access keys exist in the game, so the caller is
   always derivable: a flow from an instance acts as that instance's role; a flow from
   the ground is anonymous. Letting a level state an identity separately would allow
   scenes that contradict themselves.
2. **`intent` on a flow** (`legitimate` | `hostile`), separate from `payload`. A red
   kite probing SSH carries nothing malicious; it is hostile because of who flies it.
   `breach` needs to know that.
3. **`backendCall` on a flow.** "A Cloudling uploads a photo" is one kite whose request
   makes the instance call S3. The engine evaluates both as one journey so the trace is
   continuous. Steps carry a `leg` so playback knows when the kite becomes rain.
4. **`matched` on a trace step**: the deciding rule in structured form, next to the
   display string `ruleRef`. The least-privilege score reads it; nothing parses strings.
5. **`sequence` on a flow** makes round-robin target choice a pure function of the input.
6. **Locked ids live in the level file, not in the scene.** "The player may not edit
   this" is a fact about a level; the scene stays a description of AWS resources only.
7. **Layout is derived.** A scene stores which subnet a resource is in, never x/y.
   `src/game/layout.ts` computes positions, so scenes written by hand in JSON always
   draw correctly and snapping is a matter of choosing a subnet.
8. **Targets listen on HTTP 80.** The load balancer terminates HTTPS and forwards on
   port 80 (a common real arrangement). Listed in `docs/SIMPLIFICATIONS.md`.
9. **Health checks are evaluated over the network.** A target whose security group
   shuts out the load balancer is unhealthy, as in AWS; if all targets are unhealthy
   the load balancer fails open, as in AWS, and the trace then shows the kite stopped
   at the target's security group.
