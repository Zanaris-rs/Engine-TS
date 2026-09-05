import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';

import type { DB } from '#/db/types.js';
import { MAX_MESSAGE_COUNT, MESSAGE_KINDS, banNotice, clampMessageCount, formatUntil, muteNotice, noticeActor, recentNoticeQuery, unreadQuery } from '#/server/login/MessageCentre.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/message-centre-contract.json', import.meta.url), 'utf8')) as {
    unread_sql: string;
    kinds: string[];
    account_message_columns: string[];
    limits: { subject: number; body: number; message_count: number; tickets_per_account_per_day: number };
};

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

// Kysely quotes every identifier and names the aggregate; the contract is
// about the shape, not the quoting.
function plain(sql: string): string {
    return sql.replaceAll('"', '').replace(' as unread', '');
}

test('the unread query is the contract count, on postgres', () => {
    const { sql, parameters } = unreadQuery(postgres, 7).compile();

    assert.equal(plain(sql), `select ${fixture.unread_sql}`);
    assert.deepEqual(parameters, [7]);
});

test('the unread query is the same on sqlite, down to the placeholder', () => {
    const { sql, parameters } = unreadQuery(sqlite, 7).compile();

    assert.equal(plain(sql), `select ${fixture.unread_sql.replace('$1', '?')}`);
    assert.deepEqual(parameters, [7]);
});

test('the contract names the kinds the engine writes', () => {
    assert.deepEqual([...MESSAGE_KINDS], fixture.kinds);
    assert.equal(banNotice('mod_matt', new Date()).kind, 'ban');
    assert.equal(muteNotice('mod_matt', new Date()).kind, 'mute');
});

test('the contract names every account_message column, in order', () => {
    // A column added to the table without a line here is a column the website
    // does not know it can read.
    assert.deepEqual(fixture.account_message_columns, ['id', 'account_id', 'ticket_id', 'kind', 'subject', 'body', 'created_by_account_id', 'created_at', 'read_at']);
});

test('the count is clamped to what p2 can carry', () => {
    assert.equal(MAX_MESSAGE_COUNT, fixture.limits.message_count);
    assert.equal(clampMessageCount(0), 0);
    assert.equal(clampMessageCount(3), 3);
    assert.equal(clampMessageCount(65535), 65535);
    assert.equal(clampMessageCount(65536), 65535);
    assert.equal(clampMessageCount(1e9), 65535);
});

test('a count that is not a count is 0, not a wrapped number', () => {
    assert.equal(clampMessageCount(Number.NaN), 0);
    assert.equal(clampMessageCount(-1), 0);
    assert.equal(clampMessageCount(Number.POSITIVE_INFINITY), 0);
    assert.equal(clampMessageCount(2.7), 2);
});

test('the duplicate guard asks for unread notices of one kind since a time', () => {
    const { sql, parameters } = recentNoticeQuery(postgres, 7, 'ban', new Date('2026-09-06T12:00:00.000Z')).compile();

    assert.equal(plain(sql), 'select id from account_message where account_id = $1 and kind = $2 and read_at is null and created_at > $3');
    assert.deepEqual(parameters, [7, 'ban', new Date('2026-09-06T12:00:00.000Z')]);
});

test('until dates are written in UTC, so nobody has to guess the timezone', () => {
    assert.equal(formatUntil(new Date('2026-09-06T14:32:09.000Z')), '2026-09-06 14:32 UTC');
});

test('the notices name the moderator, or say the check was automatic', () => {
    assert.equal(noticeActor('mod_matt'), 'Mod Matt');
    assert.equal(noticeActor('automated'), 'an automated check');
});

test('a ban notice fits the subject cap and points at the appeal route', () => {
    const notice = banNotice('mod_matt', new Date('2026-09-06T14:32:00.000Z'));

    assert.ok(notice.subject.length <= fixture.limits.subject, notice.subject);
    assert.match(notice.subject, /banned until 2026-09-06 14:32 UTC$/);
    assert.match(notice.body, /Mod Matt/);
    assert.match(notice.body, /appeal/);
    assert.ok(notice.body.length <= fixture.limits.body);
});

test('a mute notice says what a mute actually does', () => {
    const notice = muteNotice('automated', new Date('2026-09-06T14:32:00.000Z'));

    assert.ok(notice.subject.length <= fixture.limits.subject, notice.subject);
    assert.match(notice.body, /an automated check/);
    assert.match(notice.body, /public chat/);
    assert.ok(notice.body.length <= fixture.limits.body);
});
