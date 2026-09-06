import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';

import { NodeSqliteDialect } from '#/db/dialect/NodeSqliteDialect.js';
import type { DB } from '#/db/types.js';
import { CHAT_RETENTION_MS, CHAT_SWEEP_BATCH, expiredChatQuery, sweepChat, sweepChatTable } from '#/server/friend/ChatRetention.js';

/**
 * The chat sweep, against a real sqlite file with more rows in it than one
 * statement is allowed to take.
 *
 * The bug this pins is not a wrong answer, it is a statement that never gets
 * one: `delete from public_chat where timestamp < $1` over a table nobody has
 * ever swept is every line anybody has said since the Postgres cutover, in one
 * transaction, against a pooler with a `statement_timeout`. It rolls back, the
 * retention is never enforced, and the next hour has an hour more to delete -
 * the failure mode where the thing that is too big to fix goes on getting
 * bigger.
 *
 * So what is asserted here is the loop: batches, a count, a stop, and rows that
 * are still there afterwards because they were not old enough.
 */

// No driver, so nothing connects: these compile queries and throw the plan
// away, which is the only way to test the SQL text without a database.
const postgres = new Kysely<DB>({
    dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: db => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler()
    }
});

const sqlite = new Kysely<DB>({
    dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: db => new SqliteIntrospector(db),
        createQueryCompiler: () => new SqliteQueryCompiler()
    }
});

const mysql = new Kysely<DB>({
    dialect: {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: db => new MysqlIntrospector(db),
        createQueryCompiler: () => new MysqlQueryCompiler()
    }
});

const CUTOFF = new Date(Date.UTC(2026, 8, 5, 12, 0, 0));

test('the delete is one statement all three backends accept', () => {
    // Written out per dialect rather than pattern-matched, because the two
    // things that make this portable are both invisible in a loose regex:
    // postgres has no LIMIT on a delete (so the limit is on a select of ids),
    // and mysql refuses a subquery that reads the table the delete is writing -
    // error 1093 - unless it is materialised, which is what `as expired` is.
    for (const [name, database, expected] of [
        ['postgres', postgres, 'delete from "public_chat" where "id" in (select "expired"."id" from (select "id" from "public_chat" where "timestamp" < $1 limit $2) as "expired")'],
        ['sqlite', sqlite, 'delete from "public_chat" where "id" in (select "expired"."id" from (select "id" from "public_chat" where "timestamp" < ? limit ?) as "expired")'],
        ['mysql', mysql, 'delete from `public_chat` where `id` in (select `expired`.`id` from (select `id` from `public_chat` where `timestamp` < ? limit ?) as `expired`)']
    ] as const) {
        const { sql, parameters } = expiredChatQuery(database, 'public_chat', CUTOFF).compile();

        assert.equal(sql, expected, name);

        // the cutoff and the batch size are both bound, and the cutoff is the
        // only clock here: nothing in this sweep asks the database what time it is
        assert.deepEqual(parameters, [CUTOFF, CHAT_SWEEP_BATCH], `${name}: bound, not interpolated`);
        assert.ok(!sql.includes('now()') && !sql.includes('current_timestamp'), `${name}: no clock in the statement`);
    }

    // and the private half is the same statement over the other table
    assert.equal(expiredChatQuery(postgres, 'private_chat', CUTOFF).compile().sql, 'delete from "private_chat" where "id" in (select "expired"."id" from (select "id" from "private_chat" where "timestamp" < $1 limit $2) as "expired")');
});

/** A scratch sqlite file with the two chat tables and nothing else in it. */
function scratch(tables: ('public_chat' | 'private_chat')[]): { db: Kysely<DB>; statements: () => number; close: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), 'chat-sweep-'));
    const file = new DatabaseSync(path.join(dir, 'scratch.sqlite'));

    if (tables.includes('public_chat')) {
        file.exec('CREATE TABLE public_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, session_uuid TEXT NOT NULL, timestamp TEXT NOT NULL, coord INTEGER NOT NULL, message TEXT NOT NULL)');
    }

    if (tables.includes('private_chat')) {
        file.exec('CREATE TABLE private_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, profile TEXT NOT NULL, timestamp TEXT NOT NULL, coord INTEGER NOT NULL, to_account_id INTEGER NOT NULL, message TEXT NOT NULL)');
    }

    let statements = 0;

    const db = new Kysely<DB>({
        dialect: new NodeSqliteDialect({ database: file }),
        log: event => {
            if (event.level === 'query') {
                statements++;
            }
        }
    });

    return {
        db,
        statements: () => statements,
        close: () => {
            file.close();
            rmSync(dir, { recursive: true, force: true });
        }
    };
}

/** `YYYY-MM-DD HH:MM:SS`, the shape the sqlite driver stores a Date as. */
function stamp(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

test('25,000 expired rows go in batches, and the rows inside the hour stay', async () => {
    const { db, statements, close } = scratch(['public_chat', 'private_chat']);

    try {
        const now = Date.UTC(2026, 8, 5, 13, 0, 0);
        const old = now - CHAT_RETENTION_MS - 60_000;
        const fresh = now - 60_000;

        // 25,000 expired public lines and 10 that are still inside the hour
        const said = [];
        for (let i = 0; i < 25_000; i++) {
            said.push({ session_uuid: 'session', timestamp: stamp(old + i), coord: 0, message: `line ${i}` });
        }
        for (let i = 0; i < 10; i++) {
            said.push({ session_uuid: 'session', timestamp: stamp(fresh + i), coord: 0, message: `recent ${i}` });
        }

        // sqlite binds one parameter per column per row, so this goes in in
        // chunks of its own - nothing to do with the sweep
        for (let i = 0; i < said.length; i += 1000) {
            await db
                .insertInto('public_chat')
                .values(said.slice(i, i + 1000) as never)
                .execute();
        }

        await db
            .insertInto('private_chat')
            .values([
                { account_id: 1, profile: 'main', timestamp: stamp(old), coord: 0, to_account_id: 2, message: 'expired pm' },
                { account_id: 1, profile: 'main', timestamp: stamp(fresh), coord: 0, to_account_id: 2, message: 'recent pm' }
            ] as never)
            .execute();

        const before = statements();
        const swept = await sweepChat(db, now);

        assert.equal(swept.said.deleted, 25_000);
        assert.equal(swept.said.stopped, false);
        assert.equal(swept.sent.deleted, 1);
        assert.equal(swept.sent.stopped, false);

        // 10,000 + 10,000 + 5,000 for public (the third is short, which is how
        // the loop knows it is done), then one for private. Four statements,
        // not one, and not one per row.
        assert.equal(statements() - before, 4);

        assert.equal(swept.cutoff.getTime(), now - CHAT_RETENTION_MS);
        assert.match(swept.message, /swept 25000 public and 1 private chat rows older than /);
        assert.ok(!swept.message.includes('a batch failed'), swept.message);

        const left = await db.selectFrom('public_chat').select('message').orderBy('id').execute();
        assert.equal(left.length, 10, 'the ten inside the hour are still there');
        assert.deepEqual(
            left.map(row => row.message),
            Array.from({ length: 10 }, (_, i) => `recent ${i}`)
        );

        const pms = await db.selectFrom('private_chat').select('message').execute();
        assert.deepEqual(
            pms.map(row => row.message),
            ['recent pm']
        );
    } finally {
        close();
    }
});

test('a batch failure logs, stops the run, and leaves the rest for the next hour', async () => {
    // no public_chat table at all: the first batch throws, which is the shape
    // of a timeout or a pooler that went away
    const { db, close } = scratch(['private_chat']);
    const errors: unknown[] = [];
    const console_error = console.error;
    const console_warn = console.warn;
    // the sqlite driver narrates a failed statement of its own accord, so what
    // is asserted is that the sweep's own catch fires, not the exact count
    console.error = (...args: unknown[]) => void errors.push(args);
    console.warn = () => {};

    try {
        const now = Date.UTC(2026, 8, 5, 13, 0, 0);
        const old = now - CHAT_RETENTION_MS - 60_000;

        await db
            .insertInto('private_chat')
            .values({ account_id: 1, profile: 'main', timestamp: stamp(old), coord: 0, to_account_id: 2, message: 'expired pm' } as never)
            .execute();

        const swept = await sweepChat(db, now);

        assert.equal(swept.said.stopped, true);
        assert.equal(swept.said.deleted, 0);
        assert.ok(errors.length > 0, 'the failure reaches the journal');

        // and the run stops: private_chat is not touched, so the hour that
        // could not delete anything did not half-delete anything either
        assert.equal(swept.sent.stopped, true);
        assert.equal(swept.sent.deleted, 0);
        assert.match(swept.message, /a batch failed, so the rest waits for the next run$/);

        const pms = await db.selectFrom('private_chat').select('id').execute();
        assert.equal(pms.length, 1, 'the private sweep never ran');
    } finally {
        console.error = console_error;
        console.warn = console_warn;
        close();
    }
});

test('a batch bigger than the table is one statement, and an empty table is still one', async () => {
    const { db, statements, close } = scratch(['public_chat']);

    try {
        const now = Date.UTC(2026, 8, 5, 13, 0, 0);
        const cutoff = new Date(now - CHAT_RETENTION_MS);

        const empty = statements();
        assert.deepEqual(await sweepChatTable(db, 'public_chat', cutoff), { deleted: 0, stopped: false });
        assert.equal(statements() - empty, 1, 'nothing to delete is still one statement, never a loop');

        await db
            .insertInto('public_chat')
            .values({ session_uuid: 's', timestamp: stamp(now - CHAT_RETENTION_MS - 1000), coord: 0, message: 'old' } as never)
            .execute();

        const one = statements();
        assert.deepEqual(await sweepChatTable(db, 'public_chat', cutoff), { deleted: 1, stopped: false });
        assert.equal(statements() - one, 1);
    } finally {
        close();
    }
});

test('the batch size is the one the sweep is documented at', () => {
    assert.equal(CHAT_SWEEP_BATCH, 10_000);
    assert.equal(CHAT_RETENTION_MS, 60 * 60 * 1000);
});
