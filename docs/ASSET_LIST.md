# Asset list

<!-- Generated from assets/manifest.json by `npm run assets:list`. Do not edit by hand. -->

Every picture the game draws, with the size, anchor and frames the code expects. Each
one is drawn as a placeholder in code until its picture exists. To add one:

1. Draw it as a transparent PNG at the size given (or a multiple of it, same proportions),
   and export it to WebP.
2. Put the WebP in `public/art/`.
3. In `assets/manifest.json`, set the entry's `file` to the file name.

No code changes. If a picture fails to load, its placeholder is drawn instead.

- **Anchor**: the point of the picture placed on its position, as fractions of its width
  and height (`0.5, 1` is the middle of the bottom edge: a Cloudling's feet).
- **Frames**: frames side by side in one strip, left to right, each the size given,
  played at the rate shown.
- **Points**: named places on the picture, as fractions (a Cloudling's hand holds the string).
- **Between two points**: stretched from one to the other, or repeated (tiled) along the way.
- **Clouds come in two layers.** The base layer is light and near-neutral, so code can tint
  it blue by band, grey when unhealthy and red when compromised; the pencil texture must
  survive the tint. An optional highlight layer (`highlight` in the manifest) carries the
  golden sunlight and the white burst; without one, a soft glow cut to the base's shape is
  used. Both layers are the same size.
- **The sky itself** is a gradient drawn in code in every region, so it costs no file.

## Priority 1: the essentials (ship with these)

### Clouds

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `cloud.stratocumulus.internet-gateway` | 120 × 46 | 0.5, 0.5 | 1 | base + highlight layers | Internet Gateway: a low stratocumulus on the VPC's lower edge, where kites come in from the ground. | placeholder |
| `cloud.stratocumulus.nat-gateway` | 104 × 50 | 0.5, 0.5 | 1 | base + highlight layers | NAT Gateway: a smaller stratocumulus in a public subnet; private clouds reach the internet through it. | placeholder |
| `cloud.cumulus.load-balancer` | 300 × 78 | 0.5, 0.5 | 1 | base + highlight layers | Application Load Balancer: a broad cumulus across both public subnets; every kite string meets it. | placeholder |
| `cloud.altocumulus.ec2-instance` | 110 × 66 | 0.5, 0.5 | 1 | base + highlight layers | One EC2 instance: a patch of altocumulus. One instance is one graphic. | placeholder |
| `cloud.altocumulus.auto-scaling-group` | 150 × 76 | 0.5, 0.5 | 1 | base + highlight layers | An Auto Scaling group, as its palette icon and while it is dragged into place. In the sky, a group is drawn as one fleet-instance cloudlet per instance. | placeholder |
| `cloud.altocumulus.fleet-instance` | 64 × 40 | 0.5, 0.5 | 1 | base + highlight layers | One instance in an Auto Scaling group's fleet: a single small cloudlet, drawn once per instance, so 4 instances are 4 cloudlets and 8 are 8. This is its largest size; a crowded fleet draws it smaller. | placeholder |
| `cloud.cumulonimbus.s3-bucket` | 150 × 380 | 0.5, 0.5 | 1 | base + highlight layers | S3 bucket: a tall cumulonimbus with an anvil top, spanning every band of sky. | placeholder |
| `cloud.cirrus.iam-role` | 130 × 50 | 0.5, 0.5 | 1 | base + highlight layers | IAM role: wispy cirrus in the high band; a thread runs down from it to the clouds that wear it. | placeholder |
| `cloud.altostratus.rds-database` | 124 × 34 | 0.5, 0.5 | 1 | base + highlight layers | RDS database: a flat, layered altostratus in a private subnet. A Multi-AZ standby is the same graphic, drawn faint in the other zone. | placeholder |
| `cloud.cirrostratus.kms-key` | 120 × 40 | 0.5, 0.5 | 1 | base + highlight layers | KMS key (customer managed): a thin cirrostratus veil in the high band, with a faint halo in the key's colour. Every cloud encrypted with this key wears the same halo. | placeholder |
| `construct.waf-net` | 300 × 30 | 0.5, 0.5 | 1 | base + highlight layers. Idle and changed (golden sunlight), tinted in code like a cloud. | AWS WAF web ACL: a woven net slung just beneath the load balancer. Red kites it blocks are caught in it, then fall. | placeholder |

### Cloudlings

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `cloudling.friendly.idle` | 34 × 58 | 0.5, 1 | 1 | hand at 0.85, 0.52 | A friendly Cloudling, standing, holding the string. The costume is a separate overlay per region. | placeholder |
| `cloudling.friendly.cheer` | 34 × 58 | 0.5, 1 | 4 at 8 fps | hand at 0.85, 0.52 | A friendly Cloudling, jumping and cheering: its kite was answered. The costume is a separate overlay per region. | placeholder |
| `cloudling.friendly.droop` | 34 × 58 | 0.5, 1 | 1 | hand at 0.85, 0.52 | A friendly Cloudling, drooping sadly: its kite was stopped or timed out. The costume is a separate overlay per region. | placeholder |
| `cloudling.hostile.idle` | 34 × 58 | 0.5, 1 | 1 | hand at 0.85, 0.52 | A hostile Cloudling, in a black hoodie, hood up, only eyes visible, holding the string. | placeholder |
| `cloudling.hostile.stamp` | 34 × 58 | 0.5, 1 | 4 at 10 fps | hand at 0.85, 0.52 | A hostile Cloudling, stamping and huffing: its kite was stopped. | placeholder |
| `cloudling.hostile.snicker` | 34 × 58 | 0.5, 1 | 4 at 10 fps | hand at 0.85, 0.52 | A hostile Cloudling, snickering: its kite got in (a breach). | placeholder |

### Kites

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `kite.friendly.flying` | 30 × 38 | 0.5, 0.5 | 1 |  | A green diamond kite, flying on its string. | placeholder |
| `kite.friendly.tangled` | 30 × 38 | 0.5, 0.5 | 3 at 8 fps |  | A green diamond kite, tangled in a network ACL's ribbon. | placeholder |
| `kite.friendly.netted` | 30 × 38 | 0.5, 0.5 | 3 at 8 fps |  | A green diamond kite, caught in WAF's net beneath the load balancer. | placeholder |
| `kite.friendly.crumpled` | 30 × 38 | 0.5, 0.5 | 1 |  | A green diamond kite, crumpled, falling to the ground. | placeholder |
| `kite.hostile.flying` | 44 × 26 | 0.5, 0.5 | 1 |  | A red kite shaped like a bird, flying on its string. | placeholder |
| `kite.hostile.tangled` | 44 × 26 | 0.5, 0.5 | 3 at 8 fps |  | A red kite shaped like a bird, tangled in a network ACL's ribbon. | placeholder |
| `kite.hostile.netted` | 44 × 26 | 0.5, 0.5 | 3 at 8 fps |  | A red kite shaped like a bird, caught in WAF's net beneath the load balancer. | placeholder |
| `kite.hostile.crumpled` | 44 × 26 | 0.5, 0.5 | 1 |  | A red kite shaped like a bird, crumpled, falling to the ground. | placeholder |

## Priority 2: the full scene

### Sky constructs and effects

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `construct.nacl-ribbon` | 48 × 8 | 0, 0.5 | 1 | between two points, tiled | Network ACL: a ribbon fence along a subnet's boundary. Repeated along each edge; a custom ACL's ribbon is drawn stronger than the default ACL's. Kites a NACL blocks tangle in it. | placeholder |
| `construct.wisp-bridge` | 120 × 16 | 0, 0.5 | 1 | between two points, stretched | Connected: a wisp bridge grown between two clouds (a Multi-AZ database's primary and standby). Stretched between them. | placeholder |
| `construct.skyway` | 120 × 14 | 0, 0.5 | 1 | between two points, stretched | Skyway: the private path from a subnet to S3 through a gateway endpoint. Stretched between them. | placeholder |
| `construct.cirrus-thread` | 120 × 6 | 0, 0.5 | 1 | between two points, stretched | Cirrus thread: from an IAM role down to each cloud that wears it. Stretched between them. | placeholder |
| `construct.bucket-shell` | 150 × 380 | 0.5, 0.5 | 1 |  | S3 Block Public Access: a pale protective shell that closes over the bucket; kites slide off it. | placeholder |
| `overlay.compromised-smoke` | 160 × 90 | 0.5, 0.5 | 1 |  | Compromised: dark, smoky edges laid over a cloud a hostile kite got into, so the state never depends on the red tint alone. Stretched to the cloud. | placeholder |
| `effect.lightning.ground` | 40 × 220 | 0.5, 0 | 1 | between two points, stretched | Availability Zone failure: lightning from the sky to the ground over the failed zone. Stretched from top to ground. | placeholder |
| `effect.lightning.cloud` | 120 × 30 | 0, 0.5 | 1 | between two points, stretched | Failover: lightning arcing from cloud to cloud (primary to standby). Stretched between them. | placeholder |
| `effect.rain` | 24 × 60 | 0.5, 0 | 4 at 10 fps |  | Response returned: a short column of rain falling from a cloud onto the Cloudling below. | placeholder |
| `construct.kms-halo` | 160 × 90 | 0.5, 0.5 | 1 | between two points, stretched | KMS halo: a faint ring around a cloud whose data is encrypted with a KMS key, in that key's colour (Level 8). Stretched to fit around the cloud: tall round the bucket, flat round the database. | placeholder |

### Cloudlings

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `cloudling.costume.us-east-1` | 34 × 58 | 0.5, 1 | 1 |  | N. Virginia costume overlay (raincoat yellow), drawn over every friendly Cloudling in Levels set in N. Virginia. | placeholder |
| `cloudling.costume.eu-central-1` | 34 × 58 | 0.5, 1 | 1 |  | Frankfurt costume overlay (brick red), drawn over every friendly Cloudling in Levels set in Frankfurt. | placeholder |
| `cloudling.costume.sa-east-1` | 34 × 58 | 0.5, 1 | 1 |  | São Paulo costume overlay (teal), drawn over every friendly Cloudling in Levels set in São Paulo. | placeholder |
| `cloudling.costume.ap-northeast-1` | 34 × 58 | 0.5, 1 | 1 |  | Tokyo costume overlay (indigo), drawn over every friendly Cloudling in Levels set in Tokyo. | placeholder |

### Weather station (CloudWatch)

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `station.body` | 60 × 130 | 0.5, 1 | 1 |  | The weather station's post, tripod feet and the arm the bell hangs from. Static. | placeholder |
| `station.anemometer` | 36 × 14 | 0.5, 0.5 | 6 at 8 fps |  | Three cups at the top of the post, spinning faster with more kites in the air. Frames show one turn. | placeholder |
| `station.dial` | 52 × 52 | 0.5, 0.5 | 1 |  | The CPU dial's face, 0% at lower left round to 100% at lower right. The coloured bands and the scaling target's tick are drawn over it in code. | placeholder |
| `station.needle` | 24 × 6 | 0.12, 0.5 | 1 |  | The dial's hand. Turned about its anchor (the pivot) to show CPU; it swings up during a CPU spike. | placeholder |
| `station.bell` | 16 × 16 | 0.5, 0.06 | 1 |  | The alarm bell, hanging from its anchor; it swings while CloudWatch's alarm rings. | placeholder |

### Regional scenes

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `scene.us-east-1.skyline` | 1280 × 120 | 0, 1 | 1 |  | N. Virginia: a faint, low-contrast skyline on the horizon: a low row of data-centre buildings, with the Washington Monument and Capitol dome faint in the far distance. Its bottom sits on the horizon. | placeholder |
| `scene.us-east-1.ground` | 1280 × 164 | 0, 0 | 1 |  | N. Virginia: the grassy ground strip, fresh green, from the horizon to the bottom of the stage. | placeholder |
| `scene.eu-central-1.skyline` | 1280 × 120 | 0, 1 | 1 |  | Frankfurt: a faint, low-contrast skyline on the horizon: the banking-district towers and the cathedral spire. Its bottom sits on the horizon. | placeholder |
| `scene.eu-central-1.ground` | 1280 × 164 | 0, 0 | 1 |  | Frankfurt: the grassy ground strip, deeper green, from the horizon to the bottom of the stage. | placeholder |
| `scene.sa-east-1.skyline` | 1280 × 120 | 0, 1 | 1 |  | São Paulo: a faint, low-contrast skyline on the horizon: a dense, wide high-rise skyline. Its bottom sits on the horizon. | placeholder |
| `scene.sa-east-1.ground` | 1280 × 164 | 0, 0 | 1 |  | São Paulo: the grassy ground strip, olive and ochre, from the horizon to the bottom of the stage. | placeholder |
| `scene.ap-northeast-1.skyline` | 1280 × 120 | 0, 1 | 1 |  | Tokyo: a faint, low-contrast skyline on the horizon: Tokyo Skytree and the high-rise skyline. Its bottom sits on the horizon. | placeholder |
| `scene.ap-northeast-1.ground` | 1280 × 164 | 0, 0 | 1 |  | Tokyo: the grassy ground strip, muted sage, from the horizon to the bottom of the stage. | placeholder |

### Narrator and interface

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `ui.narrator.idle` | 56 × 56 | 0.5, 0.5 | 1 |  | The narrator in the bottom box, idling. | placeholder |

## Priority 3: finishing touches

### Sky constructs and effects

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `ui.padlock` | 14 × 16 | 0.5, 0.5 | 1 |  | Locked: this cloud cannot be changed in this level. | placeholder |

### Regional scenes

| Id | Size (px) | Anchor | Frames | Notes | Description | File |
| --- | --- | --- | --- | --- | --- | --- |
| `ui.paper` | 1280 × 720 | 0, 0 | 1 |  | The paper background behind everything. | placeholder |

## Planned: not drawn yet

These are on the list so they can be made, but the game does not draw them yet. Each one is
hooked up, with its entry checked by the tests, when the feature that shows it is built.

| Id | Size (px) | Description |
| --- | --- | --- |
| `cloudling.operator.idle` | 34 × 58 | The operator Cloudling (Level 9): a distinct hat, holding a box-shaped kite. |
| `kite.operator.flying` | 30 × 30 | The operator's box-shaped kite (Level 9). |
| `kite.hostile.stolen` | 44 × 40 | A hostile kite carrying stolen raindrops down its string after a breach. |
| `construct.efs-mist` | 300 × 60 | EFS: a shared mist between instances in both zones (Level 10). |
| `construct.ebs-wisp` | 40 × 30 | EBS: a small wisp tied beneath one instance (Level 10). |
| `effect.wind-lines` | 120 × 20 | Forwarded: a breeze along visible wind lines to the next cloud. |
| `construct.vpc-border` | 660 × 320 | The VPC's atlas-style dashed border (drawn in code for now). |
| `construct.az-divider` | 4 × 300 | The faint dotted line between Availability Zones (drawn in code for now). |
| `ui.narrator.pointing` | 56 × 56 | The narrator pointing at something in the sky. |
| `ui.narrator.pleased` | 56 × 56 | The narrator pleased, for a finished level. |
| `ui.title-logo` | 640 × 160 | The title logo for the start screen. |
| `ui.start-key-art` | 1280 × 720 | The start screen's key art. |
| `ui.link-preview` | 1200 × 630 | The link-preview crop of the key art. |
| `ui.field-guide-book` | 48 × 48 | The Field Guide to the Sky's book icon. |
