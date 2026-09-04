import { Kysely, MysqlDialect } from 'kysely';
import type { Dialect, LogEvent } from 'kysely';
import { createPool } from 'mysql2';
import { DatabaseSync } from 'node:sqlite';

import { DB } from '#/db/types.js';
import { toSqlDateTime } from '#/db/DateFormat.js';
import { NodeSqliteDialect } from '#/db/dialect/NodeSqliteDialect.js';
import Environment from '#/util/Environment.js';

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
    database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');

    dialect = new NodeSqliteDialect({ database });
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

export function toDbDate(date: Date | string | number) {
    if (typeof date === 'string' || typeof date === 'number') {
        date = new Date(date);
    }

    return toSqlDateTime(date);
}
