# 0009 — Third round of playtest changes: honest attackers, honest marks

**Context.** Simon's feedback of 20 November 2026, mostly about Level 2. The red kite
"aimed straight at an instance" and was shown stopped by "no route" at the VPC border,
which put a red cross on a correctly configured Internet Gateway and implied an attacker
could aim at a private address at all. Elsewhere: security group names were easy to
confuse, the success card covered the endings, and the sky's labels still read as
italic on Windows.

**Decision.**

- **Red kites aim only at what the internet can reach**: an internet-facing load
  balancer or S3. Level 2's red kite now tries SSH on port 22 at the load balancer and is
  turned away by `alb-sg`; the narration explains why it could not aim at an EC2
  instance (only a private address; no bastion host or credentials). `docs/THREATS.md`
  lists every level's attacker and what stops it; a level test enforces the rule.
- **Red crosses mark faults only.** A red kite stopped by a check gets a green shield
  ("Security group: blocked"), and its trace says "blocked here". A red cross appears
  only where a green kite failed, which is where something needs changing. Simon asked
  that only clouds needing a change get a cross; every cross on a correct cloud came
  from a red kite being stopped.
- **Security groups say who wears them**: "Worn by EC2 instance A and EC2 instance B. A
  rule you change here applies to every one of them." A group named as a source reads
  `Security group "alb-sg" (worn by Application Load Balancer)`, in the dropdown and in
  the rule list.
- **The instances' group is `ec2-app-sg`** in every level (was `app-sg`), beside the load
  balancer's `alb-sg`. Level 1 introduces the two groups and why each kind of component
  gets its own; Level 2 explains chaining and that one shared group would break least
  privilege.
- **Narration says "EC2 instance(s)"** wherever it means them, in every level, along with
  objectives, hints and speech.
- **A step can highlight several clouds** (`highlight` takes a list). Level 2's step 5
  points at both EC2 instances.
- **The listener has a "What is a listener?" card**, including that a real HTTPS
  listener needs an SSL/TLS certificate on the load balancer (ACM); the game assumes one
  (SIMPLIFICATIONS 5).
- **Results wait three seconds** after the kites land (`RESULTS_DELAY_MS`), so the rain
  and data endings are seen.
- **No handwritten face anywhere**: the sky's captions, notes and tagline now use the
  body face, upright.
- **Titles are set in Press Start 2P** (`assets/fonts/`, with its OFL licence text,
  taken from Google Fonts' repository). Sizes are multiples of 8 (16 px titles, 24 px
  level numbers, 32/64 px logo) and the weight is normal, since a pixel face has no bold.
  The tray's band headings stay in the readable face.

**Consequences.** New levels must give every red kite a public target and say what stops
it in `docs/THREATS.md`.
