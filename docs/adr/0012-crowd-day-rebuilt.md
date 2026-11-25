# 0012 — Crowd Day rebuilt: one kite per Cloudling, groups 5 s apart, a fleet you can count

**Context.** Simon played Level 5 (25 November 2026) and found it broken:

- Whatever he set, the result was always 226 of 552 kites delivered (40%), whether the
  fleet was two small instances or eight large ones, and whatever the CPU target.
- The numbers did not match what he saw: the crowd grows from about 5 to 40
  Cloudlings, yet the result was counted in hundreds of kites.
- The animation was chaotic and much too fast. The fleet's growth could not be seen,
  and the CloudWatch station's dial did not visibly work.
- Nothing rewarded a sensible fleet over a big fixed one.

He described what it should be: 4 kites on room for 10 is 40% CPU. Five more
Cloudlings walk on slowly and CPU goes to 90%, which triggers the Auto Scaling group to
add capacity, and CPU comes down. Then ten more arrive: 19 on room for 20, and,
depending on the target, another doubling. Groups arrive 5 s apart. The fleet visibly
expands, 2, 4, 8 or 4, 8, 16. The crowd grows to 40. The third star is Well
architected, and a large fleet all day should not earn it.

**What was wrong.**

1. _The cause of "always 226"._ 226 of 552 is exactly what the two fixed small instances
   deliver on their own. In a headless replay, the result changes as soon as the Auto
   Scaling group is ticked as a target on the load balancer. So in Simon's runs the
   group was almost certainly never attached. Its settings could not matter, and nothing
   in the game said so: the group's card, the sky and the results were all silent about
   it.
2. _A second, hidden bug._ An unattached group with a policy still saw the CPU of the
   load balancer's other targets, so it would scale out while serving nothing. In AWS
   a group's alarm watches its own instances, which would be idle.
3. _The unit._ The crowd was counted in kites per tick, summed over 30 ticks, so 40
   Cloudlings became "552 kites".
4. _The pace._ A tick lasted 0.52 s, and every kite flew up and came back each tick.
5. _The scale-in rule_ removed one instance per tick, so the fleet trickled down and
   lagged behind the crowd instead of showing the halving Simon expected.
6. _The fleet_ was one cloud of overlapping puffs, which could not be counted.

**Decision.**

- **One Cloudling, one kite.** Each Cloudling keeps one kite up while it stays: the
  crowd's size is the load. Instances have room for 5, 10 or 20 kites (small, medium,
  large), and CPU is kites ÷ room. Results are reported in Cloudlings and instances,
  not kite-ticks. For example: "Every kite answered, all day", or "34 of 40 Cloudlings
  timed out"; "Instances serving: 2 → 4 → 8 → 16 → 8 → 4 → 2".
- **Waves.** New timeline events, `crowd-arrives` and `crowd-leaves`, which add or take
  away a group of Cloudlings from a given tick. Level 5's crowd grows 4 → 9 → 19 → 40
  at minutes 2, 6 and 10, then goes home the same way at 14, 18 and 22, over 26
  minutes. The validator checks that a wave is inside the run, nobody leaves who has
  not come, and the crowd never exceeds `MAX_CROWD` (40), the places on the ground.
  Crowd surges still exist and are still validated and tested.
- **Pace.** A tick is one CloudWatch minute and lasts 1.25 s on screen, so groups
  arrive 5 s apart and the day takes about 34 s. Newcomers walk on over the two minutes
  before they count, kites in hand, then put their kites up. Leavers reel theirs in and
  walk off, fading.
  - A kite with room flies steadily and now and then rains data back on its Cloudling.
  - A kite with no room sags to the ground, its Cloudling droops, and a note at the load
    balancer says how many had no room.
  - Dots stream from the crowd through the gateway to the load balancer and on to each
    cloud serving kites, in proportion to its room. So a group that is not a target
    visibly gets nothing.
  - Sounds mark only changes: arrivals, new timeouts, the bell, new instances serving.
- **Scale-in.** Target tracking scales out at once and in proportion (unchanged). It now
  scales in only after CPU has stayed below the target for `SCALE_IN_TICKS` (2) minutes.
  It then removes enough instances to bring CPU back to the target, but never more than
  half the fleet at once, and never below the minimum.
  - AWS says target tracking "scales out proportionally to the metric as fast as it can,
    but scales in more gradually" (Spot Fleet target tracking, which states it plainly;
    the EC2 Auto Scaling page says it "prioritizes availability … by scaling in more
    gradually").
  - With the reference solution (minimum 2, maximum 16, small, 50%) the fleet goes
    2 → 4 → 8 → 16 → 8 → 4 → 2.
  - The test "scales in gradually, one instance per tick" was replaced by tests of this
    rule: it waits two minutes, removes at most half, settles at the fewest instances
    that keep CPU at or under the target, and records what it started and removed. The
    old one-per-tick behaviour is gone by design, so its test could not stay.
- **A group's own CPU.** A group that no load balancer targets has a CPU of 0% and never
  scales out (tested).
  - Its config card says at the top: "No load balancer sends kites to this group yet…".
  - The sky captions it "no load balancer sends it kites".
  - The weather station says "web fleet: 0%, gets no kites".
- **The fleet you can count.** Each instance has its own small cloud, half the fleet in
  each Availability Zone, up to 16 (`MAX_GROUP_SIZE`; the steppers stop there).
  - Launching instances are dashed and fill in as they start; removed ones fade.
  - The caption says "4 small serving · 4 launching".
  - With the fixed instances removed, the fleet spreads across both private subnets.
- **CloudWatch.** The weather station moved to the bottom right, where there is open sky
  for its readout: the minute, "CPU 95% · target 50%", the alarm badge, and "19 kites ·
  room for 20".
  - The dial is larger, has green, amber and red bands, and marks the policy's target.
  - Its needle eases from one minute's CPU to the next.
  - The bell rings when an alarm goes into ALARM.
  - The side panel shows CloudWatch's log as the run plays, one line per change ("2′
    ALARM: CPU above 50%. Launching 2 instances"). The full log is kept afterwards.
- **Objective and stars.**
  - The objective is now "Every Cloudling's kite is answered all day: none times out"
    (100%).
  - The third star, Well architected, is "Sized to demand". All three must hold:
    - CPU is at least 30% before the crowd arrives (`crowd-quiet-cpu-at-least`).
    - The targets are in two Availability Zones on every minute
      (`crowd-zones-at-least`).
    - The fleet grows and shrinks (`crowd-scaled-out-and-back-in`).
  - Simulated outcomes: two large fixed instances meet the objective but fail the star
    (10% CPU before the crowd). So do eight large instances, a group with a minimum of
    two large, and a group with a minimum of one (one Availability Zone). A 60%, 70% or
    80% target lets kites time out while new instances start.
- **Guided narration.** Eight steps:
  1. A first run.
  2. Why it failed.
  3. Place the group.
  4. Configure it (its scaling policy pulses).
  5. Tick it as a target (the targets heading pulses).
  6. Retire the fixed instances (remove them, or untick them).
  7. Fly again.
  8. A wrap-up.
  - New predicates used by these steps: `targets-include`, `group-can-scale` and
    `none-of`.

**Consequences.**

- Level 5 takes about 34 s per run. That is slow by design, at Simon's request; a speed
  control would be a separate change.
- 266 tests pass offline.
- One playback test caught a real gap: with the station moved, the ground had places for
  only 38 Cloudlings. The crowd's spacing is now 30 px, giving 41 places.
- Rows 19–29 of `docs/SIMPLIFICATIONS.md` and the Auto Scaling and CloudWatch cards
  describe the new model.
