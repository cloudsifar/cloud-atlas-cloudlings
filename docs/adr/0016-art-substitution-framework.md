# 0016 — Every visual is named, so final art can replace it without code changes

**Context.** On 25 November 2026, starting Level 7, Simon set the rule for the game's
pictures:

> "At some point every VPC component, IAM, KMS, the S3 vertical cloud ... will all have
> their own individual graphics. Each region will have a new background graphic, and the
> cloudlings will have updated graphics. The cloudwatch weatherstation will probably
> need its own graphic as the hand animates during CPU spikes ... For now WAF and NACL
> will be a simple graphic, but again they will be substituted in future, so the logic
> should be in place to insert the correct graphic from the -as-yet-empty- list of
> artifacts."

For Level 6 he had already settled the EC2 rule: one EC2 instance is one EC2 graphic,
and a fleet is made of the smaller cluster graphic, one per instance (ADR 0015).

Until now `assets/manifest.json` listed a few sprites, and the code drew everything in
code, so a picture could not be dropped in without changing the code.

**Decision.**

1. **One manifest names every visual** (`assets/manifest.json`, 68 entries). Each entry
   gives:
   - `file` (empty until drawn), `width` and `height` at the size drawn, and `anchor`;
   - `frames` and `fps` for animations, `points` (a Cloudling's hand, where the string
     starts), `repeat` (`tile` or `stretch`, for ribbons and bridges), `highlight` and
     `states`;
   - `status` (`planned` until the code asks for it), `group`, `priority` (1–3) and a
     `description` for the artist.

   Groups:
   - **Clouds**, one per resource kind: the Internet Gateway, NAT Gateway, load
     balancer, EC2 instance, Auto Scaling group, fleet instance, S3 bucket, IAM role,
     RDS database and the WAF net.
   - **Sky constructs and effects**: the network ACL ribbon, wisp bridge, skyway,
     cirrus thread, bucket shell, compromised smoke, two kinds of lightning, rain and
     the padlock.
   - **Cloudlings**: three moods for each side, a costume for each Region, and each
     kite in each state (flying, tangled, netted, crumpled).
   - **The weather station** in parts: body, anemometer (6 frames), dial, needle
     (anchored at its pivot, turned by the code to the CPU reading) and bell.
   - **Regions**: a skyline and a ground strip for each.
   - **The interface**: the paper texture and the narrator's portrait.
   - **Planned, not yet asked for**: KMS halo, EFS mist, EBS wisp, the operator
     Cloudling and its kite, the stolen kite, wind lines, VPC border, AZ divider, more
     narrator poses, the title logo, key art, the link preview and the Field Guide
     book.

2. **The code asks for pictures by id** (`src/game/art.ts`).
   - `drawArt`, `drawArtAt` (with scale and angle) and `drawArtBetween` (tiled or
     stretched between two points) each return false when no picture is loaded.
   - In that case the caller draws its placeholder. Every hook is written that way, so
     the game looks the same today.
   - Ids are built by rule where there are many:
     - `cloudlingArtId(side, mood)`, falling back to `idle`;
     - `kiteArtId(side, state)`, falling back to `flying`;
     - `regionArtId(region, part)`;
     - `spriteIdOf(kind)` for clouds.
   - The EC2 rule is built in. A fleet draws one `cloud.altocumulus.fleet-instance` per
     instance; a standalone instance draws `cloud.altocumulus.ec2-instance`.
3. **Pictures live in `public/art/`.** To add one, put a WebP there and set the
   entry's `file`. No code changes. `loadArt` loads every named file once, at start-up,
   and redraws as each arrives. Interface pictures are set as CSS custom properties
   (`--art-ui-narrator-idle`), so styles can use them.
4. **The list for the artist is generated.** `npm run assets:list` writes
   `docs/ASSET_LIST.md` from the manifest: every picture, its size, anchor, frames and
   points, grouped and by priority. The file is left out of Prettier, since it is
   generated.
5. **Tests hold it together** (`tests/game/art.test.ts`). They fail if:
   - a resource kind, Region, mood, kite state or station part has no entry;
   - the code draws an id with no entry, or an entry the code never asks for is not
     marked `planned`;
   - an entry is incomplete, or names a file that is not there;
   - `docs/ASSET_LIST.md` is out of date.

   They also check frame selection, anchor points and the fallbacks.

**Consequences.**

- **New visuals follow the rule.** A new kind of cloud or construct gets a manifest
  entry and a hook with a placeholder (`docs/LEVEL_AUTHORING.md`, "Pictures"). Level 7's
  WAF net (`construct.waf-net`) and the custom network ACL's ribbon
  (`construct.nacl-ribbon`) were the first built this way.
- **Sizes are fixed by the layout.** Each entry gives the size the cloud is drawn at, so
  the artist's picture fits the layout without code changes. A picture of a different
  shape is scaled to that box.
- **Not done yet.** No picture exists, so the loader has not yet run against a real
  file in a browser. That needs checking when the first picture arrives: it loads,
  replaces its placeholder and keeps its anchor.
