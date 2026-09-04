/**
 * Runs the prisma CLI against whatever backend data/config/world.json selects,
 * choosing the schema and building the connection string for it.
 *
 *   npm run db:migrate         # migrate deploy
 *   npm run db:schema          # migrate dev
 *   npm run db:reset           # migrate reset --force  (guarded, see below)
 *   npm run postgres:migrate   # migrate deploy against prisma/postgres
 */
import child_process from 'child_process';
import path from 'path';

import { getDatabaseUrl, loadWorldConfig } from '#/util/WorldConfig.js';

const args = process.argv.slice(2);

function schemaArgument(): string | undefined {
    const inline = args.find(arg => arg.startsWith('--schema='));
    if (inline) {
        return inline.slice('--schema='.length);
    }

    const index = args.indexOf('--schema');
    return index === -1 ? undefined : args[index + 1];
}

const config = loadWorldConfig();
const explicitSchema = schemaArgument();

// `postgres:migrate` names the postgres schema explicitly, and is run from a
// machine whose world.json usually says sqlite - so the schema decides too
const postgres = config.db.backend === 'postgres' || (explicitSchema?.includes('postgres') ?? false);

if (!explicitSchema) {
    args.push('--schema', postgres ? 'prisma/postgres/schema.prisma' : 'prisma/multiworld/schema.prisma');
}

// `migrate reset` drops every table and re-applies from empty. Against sqlite
// that is a local file; against postgres it is whatever DATABASE_URL points at,
// which is the live database, with no confirmation prompt because --force is
// baked into the script.
const resetting = (args[0] === 'migrate' && args[1] === 'reset') || args.includes('--force-reset');

const urlConfig = postgres && config.db.backend !== 'postgres' ? { ...config, db: { ...config.db, backend: 'postgres' } } : config;
const databaseUrl = getDatabaseUrl(urlConfig);

if (databaseUrl.length === 0) {
    console.error(`No database url for backend '${urlConfig.db.backend}'. Set DATABASE_URL, or db.url in data/config/world.json.`);
    process.exit(1);
}

/** host:port/database, so the guard can name the target without its password. */
function describeTarget(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
    } catch {
        return 'the configured database';
    }
}

if (postgres && resetting && process.env.ALLOW_DESTRUCTIVE_RESET !== '1') {
    console.error(`Refusing to reset ${describeTarget(databaseUrl)}.`);
    console.error('');
    console.error('This drops every table and every row in the postgres database DATABASE_URL points at,');
    console.error('and the script passes --force, so prisma will not ask. Player saves on disk survive;');
    console.error('accounts, hiscores, friends and ignore lists do not.');
    console.error('');
    console.error('If that is genuinely what you want: ALLOW_DESTRUCTIVE_RESET=1 npm run db:reset');
    process.exit(1);
}

/**
 * Prisma does its own TLS and ignores everything src/db/query.ts sets up, so the
 * migration connection has to be told separately. Measured against the Supabase
 * pooler with `prisma db execute` on 2026-09-04:
 *
 *   (no parameters)                   connects, certificate NOT verified
 *   sslmode=require                   connects, certificate NOT verified
 *   sslmode=verify-full               connects, certificate NOT verified - the
 *                                     value is not understood, and prisma falls
 *                                     back to `prefer` silently. A trap.
 *   sslmode=require&sslaccept=strict   refused: "The certificate was not trusted"
 *
 * `require` is therefore always set: it guarantees TLS rather than prisma's
 * `prefer`, which would fall back to plaintext if the server ever declined.
 *
 * Verification is opt-in through DATABASE_SSL_STRICT because there is no way to
 * hand prisma a private trust anchor through the url. `sslcert` is prisma's
 * *client* certificate: pointing it at Supabase's root still fails on macOS
 * ("the certificate was not trusted"), and a multi-certificate PEM is rejected
 * outright. A private root has to be trusted by the platform's own store. So a
 * host that trusts it sets DATABASE_SSL_STRICT=1 and gets a verified
 * connection; everywhere else gets an encrypted one and a warning, rather than
 * a migration that cannot run at all.
 */
function withTlsParameters(url: string): string {
    const parsed = new URL(url);

    parsed.searchParams.set('sslmode', 'require');

    const ca = process.env.DATABASE_SSL_CA;

    if (process.env.DATABASE_SSL_STRICT === '1') {
        parsed.searchParams.set('sslaccept', 'strict');

        if (ca) {
            parsed.searchParams.set('sslcert', path.resolve(ca));
        }

        console.log(`Verifying the database certificate${ca ? ` against ${path.resolve(ca)}` : ' against the platform trust store'}.`);
    } else {
        console.warn('The migration connection is encrypted but the certificate is NOT verified.');
        console.warn("Set DATABASE_SSL_STRICT=1 to verify it, on a host that trusts the database's root CA.");
    }

    return parsed.toString();
}

const prismaCli = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');

const result = child_process.spawnSync(process.execPath, [prismaCli, ...args], {
    stdio: 'inherit',
    env: {
        ...process.env,
        DATABASE_URL: postgres ? withTlsParameters(databaseUrl) : databaseUrl
    }
});

if (result.error) {
    throw result.error;
}

process.exit(result.status ?? 1);
