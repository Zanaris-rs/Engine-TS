import fs from 'fs';

import { Kysely, MysqlDialect, PostgresDialect, sql } from 'kysely';
import type { Dialect, LogEvent } from 'kysely';
import { createPool } from 'mysql2';
import { DatabaseSync } from 'node:sqlite';

import { DB } from '#/db/types.js';
import { toSqlDateTime } from '#/db/DateFormat.js';
import { NodeSqliteDialect } from '#/db/dialect/NodeSqliteDialect.js';
import Environment from '#/util/Environment.js';
import { getDatabaseUrl } from '#/util/WorldConfig.js';

// src/db/types.ts is generated from prisma/postgres/schema.prisma, so it describes
// postgres values: `boolean` for members, `Date` for every timestamp, `number` for
// hiscore_large.value. sqlite and mysql return 0/1 and 'YYYY-MM-DD HH:MM:SS'
// strings for the first two. Every consumer either tests truthiness or wraps the
// value in `new Date(...)`, both of which work on either shape - the same lie the
// mysql backend has always lived with, now written down.

let dialect: Dialect;

if (Environment.db.backend === 'sqlite') {
    // the login server and friend server are separate processes sharing one file
    const database = new DatabaseSync('db.sqlite');
    // busy_timeout first: setting the journal mode needs a brief exclusive lock,
    // and with no timeout in force the second process to start just fails
    database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');

    dialect = new NodeSqliteDialect({ database });
} else if (Environment.db.backend === 'postgres') {
    dialect = new PostgresDialect({
        // imported lazily so a sqlite dev machine never loads pg at all
        pool: async () => {
            const { default: pg } = await import('pg');

            // int8 arrives as a string by default, which turns countAll() into a
            // string and any bigint column into one too
            pg.types.setTypeParser(20, Number);

            const connectionString = getDatabaseUrl(Environment);

            if (connectionString.length === 0) {
                // pg would otherwise fall back to libpq's defaults and quietly
                // try localhost, which fails much later and looks like anything
                // but "the url was never configured"
                throw new Error('No postgres connection string: set DATABASE_URL, or db.url in data/config/world.json.');
            }

            const ca = process.env.DATABASE_SSL_CA;
            const pool = new pg.Pool({
                connectionString,
                // never rejectUnauthorized: false - the database password rides
                // this connection. Keep sslmode out of the url as well: pg lets
                // url parameters override this object.
                ssl: {
                    rejectUnauthorized: true,
                    ca: ca ? fs.readFileSync(ca, 'utf8') : undefined
                },
                max: 3,
                // a stalled statement otherwise holds one of three connections
                // until TCP keepalive notices, which on a pooled Supabase is
                // minutes; the website's pool has had one since it was written
                query_timeout: 10_000,
                connectionTimeoutMillis: 10_000,
                idleTimeoutMillis: 60_000,
                keepAlive: true
            });

            // a pooler dropping an idle client emits 'error' on the pool, and an
            // unhandled one takes the process down - which systemd's
            // Restart=always then turns into a crash loop
            pool.on('error', err => {
                console.error('[db] idle client error', err);
            });

            return pool;
        }
    });
} else {
    dialect = new MysqlDialect({
        pool: async () =>
            createPool({
                database: Environment.db.name,
                host: Environment.db.host,
                port: Environment.db.port,
                user: Environment.db.user,
                password: Environment.db.pass,
                timezone: 'Z'
            })
    });
}

function logVerbose(event: LogEvent) {
    if (event.level === 'query') {
        console.log(event.query.sql);
        console.log(event.query.parameters);
    }
}

export const db = new Kysely<DB>({
    dialect,
    log: Environment.db.verbose ? logVerbose : []
});

/**
 * Fail at boot rather than on the first login: under systemd a bad url, a wrong
 * password or an untrusted certificate would otherwise look like "logins are
 * broken" rather than "the database was never reachable".
 */
export async function probeDatabase(): Promise<void> {
    await sql`select 1`.execute(db);
}

export function toDbDate(date: Date | string | number) {
    if (typeof date === 'string' || typeof date === 'number') {
        date = new Date(date);
    }

    if (Environment.db.backend === 'postgres') {
        return date.toISOString();
    }

    return toSqlDateTime(date);
}
