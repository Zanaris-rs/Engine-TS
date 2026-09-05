import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';

import type { DB } from '#/db/types.js';
import {
    AUTOMATED_ACTOR,
    MAX_MESSAGE_COUNT,
    MESSAGE_KINDS,
    NOTICE_KIND,
    PUNISHMENT_KINDS,
    banNotice,
    clampMessageCount,
    formatUntil,
    isAutomatedActor,
    liftPunishmentsQuery,
    muteNotice,
    noticeActor,
    punishmentInsertQuery,
    punishmentsQuery,
    recentNoticeQuery,
    rewriteNoticeQuery,
    staffSpawnInsertQuery,
    unreadQuery
} from '#/server/login/MessageCentre.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/message-centre-contract.json', import.meta.url), 'utf8')) as {
    unread_sql: string;
    kinds: string[];
    account_message_columns: string[];
    ticket_kinds: string[];
    ticket_statuses: string[];
    limits: {
        subject: number;
        body: number;
        message_count: number;
        tickets_per_account_per_day: number;
        ticket_replies_per_account_per_hour: number;
        staff_notices_per_actor_per_hour: number;
    };
};

// The SQL API is the thing that actually enforces the limits, and the website
// reads them from the fixture rather than hard-coding them. Reading the
// migration back is what stops the two drifting.
const migration = readFileSync(new URL('../prisma/postgres/migrations/3_message_centre/migration.sql', import.meta.url), 'utf8');

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
    assert.equal(NOTICE_KIND, 'notice');
    assert.ok(fixture.kinds.includes(NOTICE_KIND));
    assert.equal(banNotice('mod_matt', new Date()).kind, 'ban');
    assert.equal(muteNotice('mod_matt', new Date()).kind, 'mute');
});

test('the contract names every account_message column, in order', () => {
    // A column added to the table without a line here is a column the website
    // does not know it can read.
    assert.deepEqual(fixture.account_message_columns, ['id', 'account_id', 'ticket_id', 'kind', 'subject', 'body', 'created_by_account_id', 'created_at', 'read_at']);
});

test('every limit in the fixture is the number the migration enforces', () => {
    const { limits } = fixture;

    // ticket_open: five tickets per account per day
    assert.ok(migration.includes(`IF v_today >= ${limits.tickets_per_account_per_day} THEN RETURN 'rate_limited'`), 'tickets_per_account_per_day');

    // ticket_reply: the player's own messages in the last hour
    assert.ok(migration.includes(`IF v_recent >= ${limits.ticket_replies_per_account_per_hour} THEN RETURN 'rate_limited'`), 'ticket_replies_per_account_per_hour');

    // staff_notice: one actor's notices in the last hour
    assert.ok(migration.includes(`IF v_hour >= ${limits.staff_notices_per_actor_per_hour} THEN RETURN 'rate_limited'`), 'staff_notices_per_actor_per_hour');

    // and the two lengths, which every writing function checks
    assert.ok(migration.includes(`length(p_subject) > ${limits.subject}`), 'subject');
    assert.ok(migration.includes(`length(p_body) > ${limits.body}`), 'body');
});

test('the fixture names the ticket kinds and statuses the migration allows', () => {
    // The website builds its "open a ticket" form from these, and reads the
    // status filter from them, so a kind added on one side and not the other
    // is a form that submits something ticket_open refuses.
    const kinds = fixture.ticket_kinds.map(kind => `'${kind}'`).join(', ');
    assert.ok(migration.includes(`p_kind NOT IN (${kinds})`), `ticket_kinds: ${kinds}`);

    const [open, closed, ...rest] = fixture.ticket_statuses;
    assert.deepEqual(rest, [], 'a ticket is open or closed, and the SQL knows no third');
    assert.ok(migration.includes(`"status" TEXT NOT NULL DEFAULT '${open}'`), `open status: ${open}`);
    assert.ok(migration.includes(`THEN '${closed}' ELSE status END`), `closed status: ${closed}`);
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

test('the second decision inside the window rewrites the notice, expiry and all', () => {
    // The bug this replaced: the second ban was skipped, so the player's only
    // notice named the *first* one's expiry and the moderator who extended it
    // appeared nowhere.
    const notice = banNotice('mod_ash', new Date('2026-09-13T14:32:00.000Z'));
    const { sql, parameters } = rewriteNoticeQuery(postgres, 41, notice, 9, '2026-09-06T14:33:00.000Z').compile();

    assert.equal(plain(sql), 'update account_message set subject = $1, body = $2, created_by_account_id = $3, created_at = $4 where id = $5');
    assert.deepEqual(parameters, [notice.subject, notice.body, 9, '2026-09-06T14:33:00.000Z', 41]);
    assert.match(notice.subject, /banned until 2026-09-13 14:32 UTC$/);
});

test('the rewrite is the same statement on sqlite, and carries no now()', () => {
    const notice = muteNotice('automated', new Date('2026-09-13T14:32:00.000Z'));
    // an automated check has no account behind it, so the author goes back to null
    const { sql, parameters } = rewriteNoticeQuery(sqlite, 41, notice, null, '2026-09-06 14:33:00').compile();

    assert.equal(plain(sql), 'update account_message set subject = ?, body = ?, created_by_account_id = ?, created_at = ? where id = ?');
    assert.deepEqual(parameters, [notice.subject, notice.body, null, '2026-09-06 14:33:00', 41]);
    assert.doesNotMatch(sql, /now\(\)|CURRENT_TIMESTAMP|returning/i);
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

test('a punishment is a ban or a mute, and nothing else', () => {
    assert.deepEqual([...PUNISHMENT_KINDS], ['ban', 'mute']);
    assert.equal(AUTOMATED_ACTOR, 'automated');
    assert.ok(isAutomatedActor(AUTOMATED_ACTOR));
    assert.ok(!isAutomatedActor('mod_matt'));
    // the notice and the row have to agree on what "nobody decided this" is,
    // or one says "an automated check" while the other names a moderator
    assert.equal(noticeActor(AUTOMATED_ACTOR), 'an automated check');
});

test('the punishment insert names every public column, on postgres', () => {
    const { sql, parameters } = punishmentInsertQuery(postgres, {
        accountId: 7,
        username: 'bob',
        kind: 'ban',
        issuedAt: '2026-09-06T14:33:00.000Z',
        until: '2026-09-13T14:33:00.000Z',
        automated: false,
        issuedByAccountId: 9
    }).compile();

    assert.equal(plain(sql), 'insert into punishment (account_id, username, kind, issued_at, until, automated, issued_by_account_id, note, lifted_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)');
    assert.deepEqual(parameters, [7, 'bob', 'ban', '2026-09-06T14:33:00.000Z', '2026-09-13T14:33:00.000Z', false, 9, null, null]);
});

test('the same insert on sqlite, with the automated actor and no issuer', () => {
    const { sql, parameters } = punishmentInsertQuery(sqlite, {
        accountId: 7,
        username: 'bob',
        kind: 'mute',
        issuedAt: '2026-09-06 14:33:00',
        until: '2026-09-08 14:33:00',
        automated: true,
        issuedByAccountId: null
    }).compile();

    assert.equal(plain(sql), 'insert into punishment (account_id, username, kind, issued_at, until, automated, issued_by_account_id, note, lifted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    assert.deepEqual(parameters, [7, 'bob', 'mute', '2026-09-06 14:33:00', '2026-09-08 14:33:00', true, null, null, null]);
    // the timestamps are bound, not spelled: `now()` here would be a statement
    // sqlite does not have and a clock the login server does not control
    assert.doesNotMatch(sql, /now\(\)|CURRENT_TIMESTAMP|returning/i);
});

test('the public record never selects the issuer, for one account or for all', () => {
    const columns = 'select id, username, kind, issued_at, until, automated, note, lifted_at from punishment';

    const one = punishmentsQuery(postgres, 7, 50).compile();
    assert.equal(plain(one.sql), `${columns} where account_id = $1 order by issued_at desc, id desc limit $2`);
    assert.deepEqual(one.parameters, [7, 50]);

    const all = punishmentsQuery(sqlite, null, 50).compile();
    assert.equal(plain(all.sql), `${columns} order by issued_at desc, id desc limit ?`);
    assert.deepEqual(all.parameters, [50]);

    // issued_by_account_id and lifted_by_account_id are the two columns a staff
    // name could be joined out of, and neither leaves this query
    assert.doesNotMatch(one.sql, /issued_by_account_id|lifted_by_account_id/);
    assert.doesNotMatch(all.sql, /issued_by_account_id|lifted_by_account_id/);
});

test('lifting only touches punishments that are still in force', () => {
    const now = new Date('2026-09-06T14:33:00.000Z');
    const { sql, parameters } = liftPunishmentsQuery(postgres, 7, '2026-09-06T14:33:00.000Z', 9, now).compile();

    // a ban that already expired was not lifted by anybody, and stamping it
    // would have the public page crediting a moderator with the calendar
    assert.equal(plain(sql), 'update punishment set lifted_at = $1, lifted_by_account_id = $2 where account_id = $3 and lifted_at is null and (until is null or until > $4)');
    assert.deepEqual(parameters, ['2026-09-06T14:33:00.000Z', 9, 7, now]);
});

test('a spawn names the staff member, the recipient and the world', () => {
    const columns = 'insert into staff_spawn (staff_account_id, target_account_id, item_id, count, world, created_at)';

    // ::giveother - the recipient is somebody else
    const other = staffSpawnInsertQuery(postgres, {
        staffAccountId: 9,
        targetAccountId: 7,
        itemId: 995,
        count: 1000,
        world: 1,
        createdAt: '2026-09-06T14:33:00.000Z'
    }).compile();

    assert.equal(plain(other.sql), `${columns} values ($1, $2, $3, $4, $5, $6)`);
    assert.deepEqual(other.parameters, [9, 7, 995, 1000, 1, '2026-09-06T14:33:00.000Z']);

    // ::give - the staff member is their own recipient, and the row says so
    // rather than leaving the column null
    const self = staffSpawnInsertQuery(sqlite, {
        staffAccountId: 9,
        targetAccountId: 9,
        itemId: 1042,
        count: 1,
        world: 1,
        createdAt: '2026-09-06 14:33:00'
    }).compile();

    assert.equal(plain(self.sql), `${columns} values (?, ?, ?, ?, ?, ?)`);
    assert.deepEqual(self.parameters, [9, 9, 1042, 1, 1, '2026-09-06 14:33:00']);
    assert.doesNotMatch(self.sql, /now\(\)|CURRENT_TIMESTAMP|returning/i);
});

test('the lift is the same statement on sqlite, and lifted by nobody is null', () => {
    const now = new Date('2026-09-06T14:33:00.000Z');
    const { sql, parameters } = liftPunishmentsQuery(sqlite, 7, '2026-09-06 14:33:00', null, now).compile();

    assert.equal(plain(sql), 'update punishment set lifted_at = ?, lifted_by_account_id = ? where account_id = ? and lifted_at is null and (until is null or until > ?)');
    assert.deepEqual(parameters, ['2026-09-06 14:33:00', null, 7, now]);
    assert.doesNotMatch(sql, /now\(\)|CURRENT_TIMESTAMP|returning/i);
});
