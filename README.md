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
`session_profile_account_id_timestamp_idx` index, and then the message centre
(`account_message`, `ticket`, `ticket_message`, `staff_action`, their indexes,
and `report.reporter_account_id`/`report.world`), were added to the sqlite
baseline **in place**, editing `20251229170623_clean` rather than adding a
migration after it. That is deliberate: `ec2-setup/build.sh` seeds a new host
from exactly one migration directory, so sqlite has to stay a single file.
mysql, which has no such constraint, got the additive
`20260904000000_registration_columns`, `20260905000000_website_login` and
`20260906000000_message_centre` instead.

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
later changes are their own migrations, `1_register_caps`,
`2_website_login` and `3_message_centre`.

## Dependencies

- [Node.js 24+](https://nodejs.org)

> [!TIP]
> If you're using VS Code (recommended), [we have an extension to install on the marketplace.](https://marketplace.visualstudio.com/items?itemName=2004scape.runescriptlanguage)

## Workflow

Content developers should run `npm start`. The server will watch for changes to scripts and configs, then automatically repack everything.

Engine developers should run `npm run dev`. This does what `npm start` does above, but also completely restarts the server when engine code has changed.

## License
This project is licensed under the [MIT License](https://opensource.org/licenses/MIT). See the [LICENSE](LICENSE) file for details.
