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
indexes on `session_wealth`, `public_chat` and `private_chat`), and then the
invites (`account.invites_enabled`, `invite`, `invite_attempt` and their
indexes), were added to the sqlite baseline **in place**, editing
`20251229170623_clean` rather than adding a migration after it. That is
deliberate: `ec2-setup/build.sh` seeds a new host from exactly one migration
directory, so sqlite has to stay a single file. mysql, which has no such
constraint, got the additive `20260904000000_registration_columns`,
`20260905000000_website_login`, `20260906000000_message_centre`,
`20260908000000_evidence_and_records` and `20260916000000_invites` instead.

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
`3_message_centre`, `4_evidence_and_records`, `5_economy_categories`,
`6_invites`, `7_staff_spawn_total`, `8_records` and `9_record_durations`.

#### The SQL API

Postgres only. The `website` role has **no privilege on any table in `public`** —
`select * from punishment` as `website` is refused, and so is every other table
these functions read. What it has instead is `EXECUTE` on fifty-three
`SECURITY DEFINER` functions in the `accounts` schema, each with
`search_path` pinned to `public, pg_temp`, and that list is the entire surface a
leaked website credential reaches. `4_evidence_and_records` adds twelve of them
and replaces two:

- **staff** (`staff_report`, `staff_report_input`, `staff_report_chat`,
  `staff_report_wealth`, `staff_wealth`, and `staff_reports` again with the
  report's `uuid`, `has_evidence` and `resolution`) — every one guarded by
  `accounts.is_staff(p_actor)`, which re-reads `staffmodlevel` from the database
  on every call, so a stale cookie promotes nobody. They return no raw address:
  `same_ip_as_reporter` is a boolean, and that boolean is all an ip ever becomes.
- **staff writes** (`staff_report_resolve`, `staff_lift`, `staff_punishment_note`).
  The first two re-type the moderator's password — the same compare-and-set
  against their own bcrypt hash `staff_notice` uses, in a rate-limit bucket of
  its own — because one deletes evidence and the other edits the public record.
  Resolving a report as `dismissed` deletes its `report_input` and `report_chat`
  rows immediately. All three leave a `staff_action` row.
- **public** (`public_punishments`, `public_economy`, `public_economy_flow`,
  `public_staff_spawns`, and `5_economy_categories`' `public_economy_latest`
  and `public_economy_group_range`) — the transparency reads. They select only the public
  columns: no issuing or lifting moderator, no account id, no address, no name
  on a census or a spawn. The census functions read one profile — `main`, from
  `accounts.public_profile()`, a constant granted to nobody. Deliberately not a
  session setting: a GUC is settable by whoever holds the connection, so
  `website` could have pointed `/economy` at any profile with one `SET`.
  Changing it is a migration.

  `5_economy_categories` adds the other two. `public_economy_latest` returns the
  newest snapshot's `items` column — the whole census, every id in the game,
  which `public_economy` deliberately does not return — and
  `public_economy_group_range` gives each category's lowest and highest total
  across a window. The categories are an **argument** (`p_groups`) and not a
  column: "Ores", "Runes" and the rest are a decision about how to present a
  census rather than a fact about the game, so they live in the website's
  `lib/items/groups.ts` and renaming one is not a migration. Ids no group names
  are summed into the reserved key `'*'` inside the same query, because a
  minimum is not a subtraction and a residual computed by the caller would be a
  bound rather than a figure. Still no name on anything: the census counts
  objects, not owners.
- **`staff_punishment_note`** is capped at twenty an hour per moderator,
  counted off its own `staff_action` rows, because it is the one verb here that
  writes public text without re-typing a password.
- **`reap()`**, replaced. Same signature, still hourly under pg_cron, and it now
  also takes `session_wealth` older than seven days and the evidence of reports
  older than thirty days or dismissed. **Chat is not in it**: `public_chat` and
  `private_chat` are swept by their own writer, the friend server, an hour after
  they were said, because that sweep has to work on sqlite and mysql too — in
  batches of 10,000, so a table nobody has swept before does not meet a
  `statement_timeout` and roll back with an hour more to delete next time.

What has **no reaper at all** is `session_log`. Nothing deletes it, on any
schedule, on any backend: not `reap()`, not the friend server, not the login
server. That is survivable only because it is nearly empty — which is what
`logger.sessionLog` being off keeps it. Turn that on and the table grows at
about 86,000 rows a day at thirty players, forever, read by nothing. **Leave it
off**; if a fleet ever needs it, it needs a retention rule in the same
migration.

`6_invites` makes registration invite-only, replacing `accounts.register` with
nine functions. `invite_preview` answers the `/join/<code>` door without
spending anything; `register_with_invite` takes a single-use code as its first
argument and claims it in the same statement that creates the account.
`account.invites_enabled` is false by default and only
`accounts.staff_set_invites` or `npm run account -- invite-enable` turns it on;
a trigger on `account.banned_until` turns it off and revokes the account's
live links. Players read and manage their own links through `invites`,
`invite_create` and `invite_revoke`, and see their own citizen number and
inviter through `citizen`; staff see `staff_inviters` and `staff_invite_tree`, and
`10_invite_genealogy` adds `staff_invite_genealogy`: every account with the
account whose link it claimed, for the staff genealogy page.
`invite` rows that were claimed are never reaped.

`7_staff_spawn_total` lets /economy say "ever". `public_staff_spawns` clamps
its argument to 1..90 days and stops at 500 rows, and does both silently, so a
page headlining "0 items ever created by staff" from that read would be
printing a claim it had not checked. `public_staff_spawn_total` takes no
argument and returns one row - how many spawns, how many items, and the first
and last of them - and `public_staff_spawns_all` returns every row in the same
four columns the windowed read returns, so the website parses one shape
whichever it called. The windowed read stays, defined and granted, as the
fallback until the migration is applied. An empty table still answers with a
row (`0, 0, null, null`) rather than with nothing, because "nothing has ever
happened" and "the read failed" are different sentences on that page. Both
functions are unbounded on purpose: only an item-creating cheat writes to
`staff_spawn`, nothing has ever reaped it, and **nothing should** - a retention
rule added later would not make the page fail, it would make it quietly lie.

`8_records` adds timed XP records, started and stopped from the website, with
no engine change: everything reads tables the login server already keeps. A
player logs out of the game, presses Start (`record_start`), plays, logs out
before the timer runs out, and presses Stop (`record_stop`). Both snapshots
come from `hiscore` and `hiscore_large` while the player is logged out, so
neither can be stale; the window is `started_at` to the **final logout**, the
`account_login.logout_time` Stop finds, and over the duration plus ten seconds
of grace is rejected. Start and Stop both wait **five seconds past a logout**,
because the login server writes `logged_in = 0` before it runs
`updateHiscores`, and a snapshot inside that gap would read the hiscore from
before the session just ended. A session that began after the last clean
logout and ended some other way - a crash, or a forced logout, which saves
nothing - makes the attempt `void` rather than the player's failure, and a
void attempt does not count against the twelve starts an hour. Categories are
hiscore types (0 Overall, 1..21 the skills), so nothing converts to stat ids.
`record_board` publishes valid attempts only, best per player, with the hiscore
views' staff and ban rule restated; `record_current` answers every name with
exactly one row, because the account page polls it. There is no scheduler: an
attempt nobody stopped reads as abandoned an hour after its window and is
stored as such by the next Start, Stop or cancel. Nothing is reaped.

`9_record_durations` makes a record five minutes, six hours or twenty-four
hours. It is one `CREATE OR REPLACE`: `record_durations()` answers three rows
where it answered one, and every rule above already reads the duration from
that row - Start refuses a duration the list does not have, Stop takes the
grace from it, the abandoned cutoff is an hour past *its own* window, and the
boards are keyed by `duration_seconds`, so three durations are three boards
with no other line changed. It also cuts the grace to **two seconds** for all
three, which is the cut `9_record_grace` would have made, made here instead:
two seconds covers the world's tick and the login server's write of the
logout, and no longer covers combat's logout lock (sixteen ticks), so leaving
combat in time to log out before 0:00 is the player's job. Stop reads the
grace at Stop time, so an attempt already running is judged by two; an attempt
already stopped keeps its verdict. One running attempt per account still, so a
day-long attempt has to be stopped or cancelled before a five-minute one can
start - they would otherwise be measuring the same final logout twice.
**Delete `9_record_grace` rather than reviving it**: it replaces the same
function under the same number and now says less than this does, so applied
second it would take six hours and a day away with nothing to say so.

`test/EvidenceSql.test.ts` reads the migration back and asserts the grant list,
those retention windows, and that no `public_*` function so much as mentions an
issuer or an address; `test/EconomyCategoriesSql.test.ts` does the same for
migration 5, and additionally pins the two clauses in `public_economy_group_range`
whose purpose a reader would not guess — the `'*'` residual and the `CROSS JOIN`
that gives a category empty for a week a low of 0 rather than no low.
`test/StaffSpawnTotalSql.test.ts` does it for migration 7, and pins the two
things a reader could not see from the SQL: that the total has no `GROUP BY`,
so an empty table answers with a row instead of with nothing, and that no
`reap()` in any migration mentions `staff_spawn`, so the page's "ever" stays
true. `test/RecordsSql.test.ts` does it for migration 8 - the grant list, that
the board lets through `valid` only, that `record_current` has no `GROUP BY`,
the five-second wait, and that Stop checks for an unclean end before it blames
the player - and `test/RecordsSchema.test.ts` holds its two tables the same in
all five places. `test/RecordDurationsSql.test.ts` does it for migration 9: the
three rows, that the header is migration 8's so the replace swaps a body and
nothing else, that no table is touched, and that no two migration directories
share a number, which is what would let the closed grace branch overwrite this
one unnoticed. Nothing in this repo executes the file — the proof that it
answers correctly is a throwaway postgres, never the live pooler.

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

`::track` defaults to 15 minutes and is **capped at 60**; `::track <name> 0`
stops one early. Anything longer than an hour is a recording rather than a
watch, and is worth typing the command again for.

**A capture survives the offender relogging.** It is filed against the
username, not the player object, so somebody who pulls their plug halfway
through comes back into the window they left: the tail is re-armed on their new
input ring under the same uuid, with a marker 4 in the stream so the decoder
reads the gap as a logout rather than as a player who stopped moving. The chunk
numbering is the capture's, not the ring's, for the same reason. The window
closes when its clock says so — or when the world reboots, which posts every
open capture's `evidence_end` before it stops so the after-window chat is still
copied.

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
npm run account -- lift <name> [--kind ban|mute] [--from <staff>]
```

`lift` does both writes - `banned_until`/`muted_until` to null *and*
`punishment.lifted_at` - which is why it exists: an `UPDATE account SET
banned_until = NULL` in psql lets the player back in while `/bans` goes on
saying they are serving a ban nothing will ever revisit. Only punishments still
in force are stamped; one that already expired was not lifted by anybody.

`--kind` narrows it to one half. Without it both are lifted, which is the usual
case, and either way the command prints which kinds it is undoing before it does
anything — "unban but leave the mute standing" is a real decision and it should
not turn on remembering what the default was. Lifting one kind leaves the
other's state *and* its `punishment` row alone, so `/bans` does not credit
anybody with a reversal they did not make.

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
about 86,000 rows a day at thirty players, read by nothing, and into a table
with **no reaper on any backend** (see the retention notes above). Reports,
evidence and wealth events are not behind it; only that firehose is. With
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

- **Shop stock does not count.** Shop invs are *shared* scope - one inventory
  behind every instance of that shop, restocked by the world from the config -
  and belong to nobody.
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
the one that first counts it. The snapshot and the flow rows derived from it go
in **one transaction**: a reader that saw the snapshot without its flows would
see the totals move with nothing entering or leaving.

That list is `data/config/economy.json`, committed with the engine and edited by
hand: the partyhats, h'ween masks, santa hat, cracker, disk of returning, half
full wine jug, pumpkin and easter egg. Everything else is still counted in
`items`; the list is only what gets a line of its own on the site and a flow row
of its own here. A fleet that wants a different one ships a copy at
`<cwd>/data/config/economy.json`, which wins over the bundled file; each run
logs which one it read.

A save that cannot be read **stops the run** rather than being skipped, because
every item in it would otherwise read as having left the game. Fix or remove the
file, or pass `--skip-unreadable` once you have looked at it. A save the
*filesystem* refuses counts as unreadable rather than ending the run with a
stack trace — one deleted between the directory listing and the read (a player
logged out while the census was walking), or one this process may not open. A
bad file costs that file, not the hour.

A save **written in the last second** is not read yet and not skipped either:
the login server writes saves in place rather than by rename, so a file touched
this instant may be half of each. The census sets it aside, waits a second and a
half, and reads it again - twice, if it has to - which is the difference between
a snapshot that waited and a snapshot that is knowingly short. A file that
changed *while* it was being read gets the same treatment, since the mtime
window alone cannot see that. Only a save still being written after every
attempt is left out, and then it counts as a save that could not be read.

**Either of those stops the run**, and for the same reason: an incomplete
census writes **nothing at all** unless `--skip-unreadable` says otherwise. A
snapshot short of one player's bank is not a floor worth having — it sits on
`/economy` as though it were the game, and the next complete run then reads as
a spike of everything that file was holding.

With the flag the snapshot is written and **no `economy_flow` rows at all**
are, because having looked at the files does not make their items countable:
the change since the last census still cannot be told apart from a bank that
emptied. The run says `63 players (62 censused)` so the shortfall is on the
record, and the closing line names the flag that let it through.

A directory with no saves in it writes nothing whatsoever and exits cleanly —
and so does one where nothing at all was readable, once you have passed the
flag. "The game contains nothing" is nearly always "this ran in the wrong
directory", and recording it would make the next census report the entire game
as having entered it that hour.

The **filename of an unreadable save is a username**, so it goes to the
operator's stderr - the systemd journal on the hub - and nowhere else. Nothing
about who owns what reaches the database or the site; that is the whole point of
the census.

## Dependencies

- [Node.js 24+](https://nodejs.org)

> [!TIP]
> If you're using VS Code (recommended), [we have an extension to install on the marketplace.](https://marketplace.visualstudio.com/items?itemName=2004scape.runescriptlanguage)

## Workflow

Content developers should run `npm start`. The server will watch for changes to scripts and configs, then automatically repack everything.

Engine developers should run `npm run dev`. This does what `npm start` does above, but also completely restarts the server when engine code has changed.

## License
This project is licensed under the [MIT License](https://opensource.org/licenses/MIT). See the [LICENSE](LICENSE) file for details.
