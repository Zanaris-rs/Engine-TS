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
`world.json`.

Leave `sslmode` out of the URL - pg lets URL parameters override the TLS options
the engine sets, and the engine always verifies the certificate. Where the server
presents a private root (Supabase's pooler does: `Supabase Root 2021 CA`, which
is not in any system trust store), point `DATABASE_SSL_CA` at that CA in PEM
form, e.g. `DATABASE_SSL_CA=/etc/lostcity/supabase-ca.crt`.

Migrations are per backend: `npm run sqlite:migrate`, `npm run db:migrate`
(mysql) and `npm run postgres:migrate`. The postgres migration also creates
schemas, roles and grants, so it is never run automatically by the setup wizard.
`npm run db:types` regenerates `src/db/types.ts`, which every backend shares, from
`prisma/postgres/schema.prisma`.

## Dependencies

- [Node.js 24+](https://nodejs.org)

> [!TIP]
> If you're using VS Code (recommended), [we have an extension to install on the marketplace.](https://marketplace.visualstudio.com/items?itemName=2004scape.runescriptlanguage)

## Workflow

Content developers should run `npm start`. The server will watch for changes to scripts and configs, then automatically repack everything.

Engine developers should run `npm run dev`. This does what `npm start` does above, but also completely restarts the server when engine code has changed.

## License
This project is licensed under the [MIT License](https://opensource.org/licenses/MIT). See the [LICENSE](LICENSE) file for details.
