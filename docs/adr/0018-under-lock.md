# 0018 — Level 8, Under Lock: KMS keys, encryption at rest, and breaches that outlast their run

**Context.** The brief's Level 8 (Section 11):

- **The scene.** A bucket marked `sensitive` with Block Public Access off and a public
  bucket policy, and an unencrypted RDS database. The first run ends in a breach: the
  bucket turns red with the attacker's string still attached.
- **The player.** Closes the bucket, creates a customer managed KMS key, switches the
  bucket to SSE-KMS with that key, grants the app role `kms:Use`, and replaces the
  database with a new, encrypted one (the existing database's encryption setting is
  greyed out: "only at creation").
- **The trap.** Forgetting `kms:Use` breaks the app's own uploads at the KMS check.
- **Objectives.** The red kite cannot reach the data; the app still reads and writes;
  the database is encrypted.
- **★3.** One customer managed key protects both stores.

The brief also asks (Section 6) that a compromised cloud stays compromised "until the
player closes it", and lists "the snapped string when a breach is fixed" among the
signs of recovery. Until now a breach disappeared from the sky with any edit, because
only a run that matched the current scene was drawn.

Simon, after Level 7: "Excellent work. The logic and playability is done to a very high
standard ... Now do level 8, building on the work and insights you gained developing
level 7."

**Decision.**

The level (`levels/08-under-lock.json`, São Paulo, guided with hints):

- **The scene.** The hat shop from Level 7, keeping lessons from earlier levels:
  - the web servers reach S3 through a gateway endpoint (Level 4);
  - the database's security group trusts the web servers' group (Level 6).

  Visitors upload receipts to the `receipts` bucket and look up orders in the
  `orders database`. The bucket is public: Block Public Access is off, and its policy
  lets everyone read. The red Cloudling reads every receipt straight from S3, outside
  the VPC. The database was created unencrypted. The role allows only `s3:Write` on
  the bucket.

- **Eight narrator steps, one change and one flight each.**
  1. A first run: a breach.
  2. Why the bucket is public.
  3. Close it: Block Public Access on, and the public statement removed. The narrator
     says why the second matters when the first overrides it: a permission nobody needs
     is waiting for the day someone switches Block Public Access off. Least privilege
     (★2) checks it.
  4. The receipts were never unencrypted (SSE-S3 since January 2023, never taught as
     "unencrypted by default"). Drag in a customer managed key.
  5. Set the bucket to SSE-KMS with the key. The step says new receipts use it and
     stored ones keep SSE-S3.
  6. The trap: the uploads fizzle against the halo. Add `kms:Use` on the key to the
     role.
  7. Replace the database with an encrypted copy.
  8. Wrap-up, linked to the "Encryption at rest" card, with the third-star hint.
- **Objectives.** Four rather than the brief's three:
  1. The red Cloudling can no longer read the receipts.
  2. Every visitor is answered (uploads stored, orders found).
  3. New receipts are encrypted with a customer managed key (added).
  4. The database is encrypted.

  Without the third, SSE-KMS and the `kms:Use` trap, the level's title lesson, would
  only matter for the third star.

- **★3** as the brief has it: one customer managed key for both stores. Step 7 does not
  name a key, and the card offers the AWS managed key aws/rds first, as the RDS console
  does. A player who follows the text has two stars and a hint to use `shop-key` for the
  copy too.

AWS behaviour modelled (`docs/ENGINE.md`, section 17; checked against the AWS
documentation and cited in `tests/engine/kms.test.ts`):

- **SSE-KMS.**
  - Storing an object needs kms:GenerateDataKey on the key and reading one needs
    kms:Decrypt, modelled as one `kms:Use`.
  - The AWS managed key aws/s3 lets every principal in the account use it through S3.
  - A customer managed key's default policy delegates to IAM, so the role must allow
    it.
  - The KMS check comes after S3 has authorised the caller, and is drawn at the bucket.
- **Default encryption applies to new objects.** Changing it does not re-encrypt what is
  stored, so switching a public bucket to SSE-KMS does not stop the red Cloudling, which
  reads the stored receipts. Only closing the bucket does. Encryption at rest is not
  access control, and the trace says so.
- **RDS.**
  - Encryption at rest can be set only at creation. An unencrypted database is replaced
    by an encrypted copy: snapshot, copy with encryption on, restore.
  - The card does this in one action and keeps the database's name, so the application
    still connects.
  - The application needs no KMS permission to query an encrypted database: RDS uses
    the key itself.
- **A key that still encrypts something cannot be removed.** In AWS, deletion waits 7 to
  30 days, and data under a deleted key is lost for good.

The interface:

- **The bucket's card.** A Default encryption choice (SSE-S3, SSE-KMS with aws/s3, or
  SSE-KMS with each customer managed key), and a note that it applies to new objects.
- **The database's card.** "Encryption at rest", with the setting greyed out ("set only
  when a database is created"), a key choice, and "Replace with an encrypted copy".
- **The role's card.**
  - It offers `kms:Use` once a key exists, and names each resource with its kind.
  - It refuses a statement whose action belongs to another service (`kms:Use` on a
    bucket), with the reason.
- **The key's card.** What the key protects, its default policy, and how it differs from
  AWS managed keys. While the key encrypts something, its card explains why it cannot be
  removed.

The sky:

- **Halos** (brief, Section 6). Each customer managed key has a colour: the key wears it,
  and so does every bucket and database encrypted with it. One key protecting both
  stores reads as three matching halos. An AWS managed key gives a dashed grey halo, and
  SSE-S3 none.
  - Captions under the bucket ("SSE-KMS · shop-key") and beside the database
    ("encrypted: shop-key") say the same in words, so colour is never the only signal.
  - The database's second caption line describes encryption, except in a level about
    zones failing, where it keeps "single-AZ", "primary" and so on.
- **The key itself.** A cirrostratus veil in the high band, after the roles, with a key
  drawn on it.
- **Art.** `cloud.cirrostratus.kms-key` and `construct.kms-halo` are in the manifest and
  asked for by the code (ADR 0016).
- **Web servers share the private subnets with a database.** They sit higher, so their
  captions clear the database (tested).
- **The skyway's caption** ("S3 gateway endpoint") is drawn after the clouds, because the
  bucket used to hide half of it.

Breaches that outlast their run (`skyView.ts`, `render.ts`):

- **A breach stays shown.** After a run with a breach, the compromised cloud stays red,
  with the attacker's string tied to it and stolen raindrops trickling down, even after
  the player changes the sky.
- **The string snaps when the cause is fixed.** After each change, the game asks
  whether the attacker would still get in, by rehearsing the same pure, deterministic
  run that flying would make (`rehearse` in `store.ts`, kept once per scene; the Fly
  button's pointer from ADR 0017 now uses it too). As soon as the answer is no:
  - the string snaps, its top end whips back into the cloud, and the rest falls slack;
  - the crumpled kite drops beside its stamping Cloudling;
  - the cloud is no longer compromised;
  - a placeholder `string-snap` sound plays.

  The snap takes 2.4 seconds, so it can be watched.

- **The same holds in every level.** In Level 7, switching Public subnet A to `edge-acl`
  snaps the string of the attacker whose path crossed it, while the others hold until
  their own path is closed.

**Consequences.**

- **Tests.** 419 tests in 26 files on the offline runner:
  - `tests/engine/kms.test.ts` (cites the AWS pages) covers SSE-S3, aws/s3, the customer
    managed key with and without `kms:Use`, `*`, an explicit deny, reads, deletes, the
    order of IAM and KMS checks, the public bucket after SSE-KMS, RDS answers and their
    explanations, validation, the predicates, least privilege and cost;
  - `tests/game/underLock.test.ts` covers the edits, the removal guard, the statement
    refusals, the layout, the rehearsal behind the snapped string, and the Fly pointer;
  - the level tests run the reference solution and the level's rules.
- **Probed.** Every trap behaves as designed:
  - Block Public Access on alone, or the public statement removed alone, stops the red
    kite;
  - SSE-KMS without `kms:Use` fails both uploads at the key;
  - `kms:Use` on `*` works but costs ★2;
  - `kms:Use` on the bucket is refused;
  - an explicit deny wins;
  - aws/s3 misses objective 3;
  - aws/rds misses ★3;
  - reopening an encrypted bucket is a breach again.
- **Played through headlessly** in the built game, every step by the interface:
  - the snap seen at 250 and 850 ms;
  - the Fly button pointed after each change;
  - two stars with aws/rds, then three with `shop-key`;
  - no console errors.

  Level 7's first steps were replayed to check the snapping there.

- **Simplifications.** Rows 45–51 in `docs/SIMPLIFICATIONS.md`:
  - `kms:Use` for GenerateDataKey and Decrypt;
  - only the default key policy;
  - a key in use cannot be removed;
  - stored objects on SSE-S3, app objects under the current default;
  - no Bucket Keys;
  - an instant encrypted copy that keeps its name;
  - the role card's refusals.

  The `kms-key`, `s3-bucket` and `rds-database` fact cards disclose the ones players
  meet. Level 6's database now names the AWS managed key aws/rds, which changes nothing
  in that level.

- **Still to check on Windows with npm:**
  - `npm test` and `npm run build`, expecting 419 tests in 26 files;
  - ESLint and Prettier;
  - the `string-snap` and `blocked-iam` sounds by ear.
