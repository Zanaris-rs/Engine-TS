<div align="center">
    <h1>Lost City - November 23, 2004</h1>
</div>

> [!NOTE]
> Learn about our history and ethos on our forum: https://lostcity.rs/t/faq-what-is-lost-city/16

Reverse-engineered engine code designed to accurately simulate the cycle behaviors of early RS2. Contains the necessary data tools and compatible network protocol.

Game data is in the [Content](https://github.com/LostCityRS/Content) repository.

The project organizes historical versions into branches. You will need matching engine and content branches together to run the project.

## Getting Started

> [!IMPORTANT]
> If you run into issues, please see our [common issues](#common-issues).

The [Server](https://github.com/LostCityRS/Server) repository will simplify setup for most users. Download that repository and follow the instructions there.

### Manual Setup

In absence of the [Server](https://github.com/LostCityRS/Server) scripts, download the specific engine and content repositories/branches you desire and extract them to the same parent folder.

```sh
git clone https://github.com/LostCityRS/Engine-TS -b 274 --single-branch engine
git clone https://github.com/LostCityRS/Content -b 274 --single-branch content
cd engine
npm start
```

\* *use `--single-branch` when you don't need to track the commit history of all versions*

Open [http://localhost:8898/setup](http://localhost:8898/setup) to configure world settings.
This page reads and writes `data/config/world.json` through the management server.

### Client

[Client-Java](https://github.com/LostCityRS/Client-Java) is available for all versions. This is a research project to decompile and understand the original code. It has minor fixes for OS and Java compatibility.

[Client-TS](https://github.com/LostCityRS/Client-TS) may be available depending on the version. This is a human-driven port of the original code to modern browsers. This gets prebuilt and included in this repository if available.

You can use the original obfuscated compiled applet from this time period with these arguments: `java -cp runescape.jar client 10 0 highmem members 32`  
Be aware it may have compatibility issues (that are addressed in the Client-Java repository).

## Database

`db.backend` in `data/config/world.json` selects `sqlite` (the default, a local
file), `mysql`, or `postgres`.

Postgres reads its connection string from `DATABASE_URL` if it is set, falling
back to `db.url`. Prefer the environment variable: the setup UI round-trips the
config through `PUT /setup/config`, so anything in `db.url` is written back into
`world.json`. If neither is set the server refuses to start rather than falling
back to a localhost default.

### TLS

**At runtime**, leave `sslmode` out of the URL - pg lets URL parameters override
the TLS options the engine sets, and the engine always verifies the certificate.
Where the server presents a private root (Supabase's pooler does:
`Supabase Root 2021 CA`, which is in no system trust store), point
`DATABASE_SSL_CA` at that CA in PEM form, e.g.
`DATABASE_SSL_CA=/etc/lostcity/supabase-ca.crt`. Without it the connection is
refused, which is the intended direction to fail in.

**During migrations** Prisma does its own TLS and ignores all of the above, so
`prisma-multi.ts` builds the connection string separately. It always sets
`sslmode=require`, so the connection cannot silently fall back to plaintext.
Certificate verification is opt-in with `DATABASE_SSL_STRICT=1`, which adds
`sslaccept=strict` (and `sslcert=$DATABASE_SSL_CA` when that is set); without it
you get a warning on every run saying the certificate was not verified.

Two things measured against the Supabase pooler on 2026-09-04, both worth
knowing before you reach for something that looks stricter:

- `sslmode=verify-full` **does not work**. Prisma does not understand the value,
  falls back to `prefer`, and connects without verifying anything - silently.
  Use `sslaccept=strict`, which does fail closed.
- Prisma cannot be handed a private trust anchor through the URL. `sslcert` is
  its *client* certificate; pointing it at Supabase's root still fails with "the
  certificate was not trusted", and a multi-certificate PEM is rejected outright.
  So `DATABASE_SSL_STRICT=1` only succeeds on a host whose own trust store
  already carries the root.

### Migrations

Per backend: `npm run sqlite:migrate`, `npm run db:migrate` (mysql) and
`npm run postgres:migrate`. The postgres migration also creates schemas, roles
and grants, so it is never run automatically by the setup wizard.

`npm run db:reset` **drops every table and every row** and passes `--force`, so
prisma does not ask. Against postgres that is the live database `DATABASE_URL`
points at, so it refuses unless you mean it:
`ALLOW_DESTRUCTIVE_RESET=1 npm run db:reset`.

`npm run db:types` regenerates `src/db/types.ts`, which every backend shares,
from `prisma/postgres/schema.prisma`.

`npm run db:smoke` runs every shape of query the login and friend servers issue
against the configured backend, then deletes what it made.

#### The regenerated sqlite baseline

The registration columns (`email`, `email_normalized`, `registration_group`,
`signup_agent_hash`, `playable_after`, plus the `signup_attempt` table and its
indexes), then the `login_attempt` table and the
`session_profile_account_id_timestamp_idx` index, then the message centre
(`account_message`, `ticket`, `ticket_message`, `staff_action`, their indexes,
and `report.reporter_account_id`/`report.world`), and then the report evidence
and records (`report_input`, `report_chat`, `punishment`, `staff_spawn`,
`economy_snapshot`, `economy_flow` and their indexes, the eight columns
migration 4 adds to `report` - `uuid`, `offender_account_id`,
`offender_session_uuid`, `offender_coord`, `resolved_at`, `resolution`,
`resolved_by_account_id`, `staff_note` - with `report_uuid_idx` and
`report_offender_account_id_timestamp_idx`, and the retention and evidence
indexes on `session_wealth`, `public_chat` and `private_chat`), were added to
the sqlite baseline **in place**, editing `20251229170623_clean` rather than
adding a migration after it. That is deliberate: `ec2-setup/build.sh` seeds a
new host from exactly one migration directory, so sqlite has to stay a single
file. mysql, which has no such constraint, got the additive
`20260904000000_registration_columns`, `20260905000000_website_login`,
`20260906000000_message_centre` and `20260908000000_evidence_and_records`
instead.

Editing it in place is easier than it sounds: the baseline is exactly what
`prisma migrate diff --from-empty --to-schema-datamodel
prisma/singleworld/schema.prisma --script` prints, so change the schema and
redirect that command over the file rather than hand-writing the statements.

The cost is that a `db.sqlite` created before an edit is **silently** left
behind. prisma 6 records the baseline's checksum but does not compare it on
deploy, so `npm run sqlite:migrate` and `prisma migrate status` both say the
database is up to date while the tables the edit added are simply not there.
Nothing fails, which is why it is worth checking by hand:

```bash
npx prisma migrate diff --from-url file:db.sqlite \
    --to-schema-datamodel prisma/singleworld/schema.prisma --script
```

`-- This is an empty migration.` means the database is in step. Anything else
is exactly what it is missing, and there are two ways out:

```bash
# 1. dev databases: throw it away and migrate from scratch
rm db.sqlite && npm run sqlite:migrate
```

```bash
# 2. a database with data in it: apply the catch-up statements
npx prisma migrate diff --from-url file:db.sqlite \
    --to-schema-datamodel prisma/singleworld/schema.prisma --script \
    | sqlite3 db.sqlite
```

The `_prisma_migrations` row needs no fixing up afterwards: the baseline is
already recorded as applied under its old checksum, and `migrate resolve
--applied` refuses (`P3008`) for that reason. Only new columns that are `NOT
NULL` with no default need care — `email` and `email_normalized` are, and
sqlite's `ALTER TABLE ADD COLUMN` demands a `DEFAULT ''` for them, so a table
that predates the registration columns wants those two statements edited and
the values back-filled.

The postgres side has no baseline problem: `0_init` was never edited, and the
later changes are their own migrations, `1_register_caps`, `2_website_login`,
`3_message_centre` and `4_evidence_and_records`.

## Reports and evidence

A Report Abuse used to reach a moderator as a row with a reason code and
nothing behind it. For **macroing** and **bug abuse** it now carries evidence,
and the piece that makes that possible is that recording is always on.

Every player has an in-memory **input ring**
(`src/engine/entity/tracking/InputRing.ts`): their mouse movement, clicks,
camera and window focus, framed into chunks that rotate at 1500 bytes or 60
seconds. Sixteen chunks are kept - roughly the last ten minutes, at most 24 KB
a player - and the rest is thrown away. Nothing leaves the world process until
somebody is reported. This is the fix for the thing that made the old capture
useless: tracking was switched on *by* the report, so the record began after
the moment that caused it.

When a macro or bug-abuse report lands (or a moderator types
`::track <name> [minutes]`), the world generates a uuid and:

- tells the logger a capture has started, which is what makes it copy the
  offender's chat for the 30 minutes leading up to the report. That message
  goes out whether or not there is any input to go with it - somebody who
  logged in a minute ago has an empty ring, and chat is evidence either way;
- submits the whole ring, oldest chunk first, as the **before** window;
- runs a 15-minute **live tail**, submitting each chunk as it rotates;
- copies the chat from the other side of the report when the window closes.

Only the offender's own words are copied: what they said out loud and the
private messages they sent, never what was said to them.

One capture per offender per window - six people reporting the same macroer get
one copy of the evidence, not six, and a second report extends the window
rather than opening a second capture over the same minutes - and five live
tails per world; past that a report still gets the ring and no tail. The
framing itself is a cross-repo contract, pinned in
`test/fixtures/input-tracking-contract.json` and decoded by the website.

Chat is swept hourly by the friend server, an hour after it was said. The
evidence copy is what keeps any of it.

### Punishments and the public record

`account.banned_until` and `account.muted_until` are *state* - whether somebody
can log in or be heard right now - and lifting one erases it. So every ban and
every mute also writes a row to `punishment`, which is the permanent record the
website's `/bans` page reads: kind, when, until when, whether a person or an
automated check decided, and whether it was lifted. Nothing rewrites or deletes
one. A ban extended inside the hour leaves **one** message-centre notice (the
latest one, rewritten) and **two** punishment rows, because two decisions were
taken.

This happens on a dev world too. `::ban` and `::mute` are production-gated, but
the automated paths are not - a Report Abuse with a reason code outside the enum
and private-message spam both ban for two days on any world with the login
server enabled. Those bans are real, so the rows recording them are too.

Two commands read and undo it:

```sh
npm run account -- punishments [name]        # the public record, newest first
npm run account -- lift <name> [--from <staff>]
```

`lift` does both writes - `banned_until`/`muted_until` to null *and*
`punishment.lifted_at` - which is why it exists: an `UPDATE account SET
banned_until = NULL` in psql lets the player back in while `/bans` goes on
saying they are serving a ban nothing will ever revisit. Only punishments still
in force are stamped; one that already expired was not lifted by anybody.

**A lifted mute does not reach a player who is already online.**
`player.muted_until` is read from the database at login and cached in the world
process, and `lift` writes to the database only - so somebody muted and then
lifted mid-session stays muted until they log out and back in. A lifted ban has
no such problem: `banned_until` is only ever read on the way in.

### Running the logger in dev

The evidence goes to the **logger server**. A world that cannot reach it holds
what it could not send - at most 32 messages, retried every 15 seconds, dropped
after 5 minutes - so a restart during a deploy costs nothing and a logger that
stays down costs the tail of whatever was being captured. Everything else
(session logs, wealth events) is fire-and-forget and simply lost.

Run it alongside the others:

```sh
npm run logger   # alongside npm run login, npm run friend and npm run dev
```

Turn it on in `data/config/world.json`:

```json
"logger": { "enabled": true, "sessionLog": false, "host": "localhost", "port": 43501 }
```

`logger.sessionLog` is **off by default and should stay off**. It gates the
"Server check in" session-log row written for every player every 50 ticks -
about 86,000 rows a day at thirty players, read by nothing. Reports, evidence
and wealth events are not behind it; only that firehose is. With
`logger.enabled` false the world creates no logger thread at all and builds no
batches for it.

The logger binds `0.0.0.0`, exactly as the login and friend servers do, and is
kept private by the security group rather than by the bind address; worlds on
other hosts reach it over the fleet's WireGuard link. Do not expose 43501.

### Economy census

The other half of the public record is what exists in the game.

```sh
npm run economy                 # census this profile, write a snapshot
npm run economy -- --dry-run    # count and print, write nothing, open no database
```

It reads every `data/players/<profile>/*.sav` with a standalone save reader
(`tools/server/SaveReader.ts` - `PlayerLoading` would import `World`, which
spawns worker threads to read a few kilobytes), sums every item id across the
**permanent** inventories, and writes one `economy_snapshot`: the player count,
coins, the whole census as `{item_id: count}`, and the tracked subset beside it.
On the hub a systemd timer runs it hourly. Nothing it writes names an account -
it never knew one - which is what lets `/economy` say a partyhat entered the
game.

**What counts is what is in a save file.** Backpack, worn and bank, of every
account that has ever logged out. So:

- **Shop stock does not count.** Shop invs are temp scope, rebuilt from the
  config at startup, and belong to nobody.
- **Ground items do not count.** Neither do items in a trade window, a duel
  stake or any other temp inv: they are mid-flight, and the save is where things
  come to rest.
- **An online player counts as of their last save**, which is at most 15 minutes
  old. A census taken more often than the autosave would say the same thing
  twice.
- **An account that never logs out again still counts.** Its save is still
  there, so its items still exist by this definition.

`economy_flow` is the change: one signed row per tracked item whose count moved
since the previous snapshot, positive entered the game and negative left it. The
first census for a profile writes none - there is nothing to compare it to - and
neither does an item only just added to the tracked list, until the run after
the one that first counts it.

That list is `data/config/economy.json`, committed with the engine and edited by
hand: the partyhats, h'ween masks, santa hat, cracker, disk of returning, half
full wine jug, pumpkin and easter egg. Everything else is still counted in
`items`; the list is only what gets a line of its own on the site and a flow row
of its own here. A fleet that wants a different one ships a copy at
`<cwd>/data/config/economy.json`, which wins over the bundled file; each run
logs which one it read.

A save that cannot be read **stops the run** rather than being skipped, because
every item in it would otherwise read as having left the game. Fix or remove the
file, or pass `--skip-unreadable` once you have looked at it.

## Dependencies

- [Node.js 24+](https://nodejs.org)

> [!TIP]
> If you're using VS Code (recommended), [we have an extension to install on the marketplace.](https://marketplace.visualstudio.com/items?itemName=2004scape.runescriptlanguage)

## Workflow

Content developers should run `npm start`. The server will watch for changes to scripts and configs, then automatically repack everything.

Engine developers should run `npm run dev`. This does what `npm start` does above, but also completely restarts the server when engine code has changed.

## License
This project is licensed under the [MIT License](https://opensource.org/licenses/MIT). See the [LICENSE](LICENSE) file for details.
