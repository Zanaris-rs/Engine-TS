import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 14, read back from the file. Its behaviour is rehearsed against a
// real postgres outside this repo (tests/migration-014.sql); what must not
// drift silently is pinned here. The directory shows only what a log already
// shows anyone - twenty minutes late, hidden categories hidden, banned logs
// gone - and it asks each account for its newest adventure instead of reading
// the event table by time, which only grows.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/014_adventure_directory/migration.sql');
const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

const ROLLBACK = '\n-- rollback:';
const MARKER = '-- === functions ===';
assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');

const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

function functions(sql: string): Map<string, { header: string; body: string }> {
    const found = new Map<string, { header: string; body: string }>();

    for (const match of sql.matchAll(/CREATE OR REPLACE FUNCTION accounts\.(\w+)\(/g)) {
        const start = match.index;
        const open = sql.indexOf('$$', start);
        const close = sql.indexOf('$$;', open + 2);

        assert.notEqual(open, -1, `${match[1]}: no body`);
        assert.notEqual(close, -1, `${match[1]}: no end of body`);

        found.set(match[1], { header: sql.slice(start, open), body: sql.slice(open + 2, close) });
    }

    return found;
}

const defined = functions(live);
const directory = defined.get('adventure_log_directory');
const replies = defined.get('adventure_log_recent_replies');

const GRANTED = ['adventure_log_directory(timestamptz, text, int)', 'adventure_log_recent_replies(text, int)'];
const INDEX = 'CREATE INDEX IF NOT EXISTS "adventure_event_directory_idx" ON "adventure_event"("account_id", "profile", "occurred_at" DESC) INCLUDE ("category");';

test('migration 14 defines the two functions and nothing else', () => {
    assert.deepEqual([...defined.keys()], ['adventure_log_directory', 'adventure_log_recent_replies']);
    assert.ok(!live.slice(0, live.indexOf(MARKER)).includes('CREATE OR REPLACE FUNCTION'), 'no functions above the marker');
});

test('the website codes against these columns', () => {
    // The website reads these columns by name, so a change here is a change
    // there too.
    assert.ok(directory?.header.includes('(p_before_at timestamptz, p_before_username text, p_limit int)'), 'directory arguments');
    assert.ok(directory?.header.includes('RETURNS TABLE (username text, headline text, last_at timestamptz, last_kind text, last_category int, last_body text)'), 'directory columns');
    assert.ok(replies?.header.includes('(p_username text, p_limit int)'), 'replies arguments');
    assert.ok(replies?.header.includes('RETURNS TABLE (reply_id int, update_id int, author text, body text, created_at timestamptz, update_body text, author_blocked boolean)'), 'replies columns');
});

test('both are reads: STABLE, SECURITY DEFINER, search_path pinned', () => {
    for (const [name, fn] of Object.entries({ directory, replies })) {
        assert.ok(fn, name);
        assert.ok(fn.header.includes('LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp'), name);
    }
    // thousands of cheap index steps are priced high enough to JIT-compile,
    // and the compile takes longer than the query
    assert.ok(directory?.header.includes('SET jit = off'), 'no JIT for the directory');
});

test('the directory shows what a log shows anyone', () => {
    const body = directory?.body ?? '';
    // 013's adventure_timeline with no viewer, and no owner's view here at all
    assert.ok(body.includes("e.occurred_at <= now() - interval '20 minutes'"), 'twenty minutes late');
    assert.ok(!body.includes('is_owner'), 'the owner has no early view in the directory');
    assert.ok(body.includes('AND (coalesce(p.hidden_categories, 0) & (1 << e.category)) = 0'), 'hidden categories');
    assert.ok(body.includes('e.profile = accounts.public_profile()'), 'the public profile only');
    assert.ok(body.includes('u.deleted_at IS NULL AND u.staff_hidden_at IS NULL'), 'shown updates only');
    assert.ok(body.includes('(a.banned_until IS NULL OR a.banned_until <= now())'), 'no banned logs');
    assert.ok(body.includes('(e.at IS NOT NULL OR u.at IS NOT NULL)'), 'no empty logs');
});

test('a page is newest first, strictly after the cursor, 1..50 rows and one more', () => {
    const body = directory?.body ?? '';
    assert.ok(body.includes('LIMIT least(greatest(coalesce(p_limit, 30), 1), 50) + 1'), 'the clamp and the extra row');
    assert.ok(body.includes('ORDER BY greatest(l.event_at, l.update_at) DESC, l.username'), 'page order');
    assert.ok(body.includes('ORDER BY pg.at DESC, pg.username;'), 'result order');
    assert.ok(body.includes('OR greatest(l.event_at, l.update_at) < p_before_at'), 'older');
    assert.ok(body.includes("OR (greatest(l.event_at, l.update_at) = p_before_at AND l.username > coalesce(p_before_username, ''))"), 'same time, later name');
    // an update and an adventure in the same millisecond: the update, as at
    // the top of the timeline (rank 1 before rank 0)
    assert.ok(body.includes('l.update_at IS NOT NULL AND (l.event_at IS NULL OR l.update_at >= l.event_at) AS is_update'), 'the update wins a tie');
});

test('it asks each account for its newest adventure, from the index alone', () => {
    assert.ok(live.slice(0, live.indexOf(MARKER)).includes(INDEX), 'the covering index, above the functions');
    assert.match(directory?.body ?? '', /WHERE e\.account_id = a\.id AND e\.profile = accounts\.public_profile\(\)[\s\S]*?ORDER BY e\.occurred_at DESC\s+LIMIT 1/, 'one step per account');

    // Prisma cannot say INCLUDE; the schemas say where it lives instead
    for (const [name, schema] of Object.entries(schemas)) {
        assert.ok(schema.includes('(014_adventure_directory)'), `${name} mentions the index`);
    }
});

test('recent replies: shown updates, shown replies, blocked authors marked, 1..100', () => {
    const body = replies?.body ?? '';
    assert.ok(body.includes('(owner.banned_until IS NULL OR owner.banned_until <= now())'), 'not for a banned owner');
    assert.ok(body.includes('u.deleted_at IS NULL AND u.staff_hidden_at IS NULL'), 'shown updates');
    assert.ok(body.includes('r.deleted_at IS NULL AND r.staff_hidden_at IS NULL'), 'shown replies');
    assert.ok(body.includes('(ra.banned_until IS NULL OR ra.banned_until <= now())'), 'not from banned authors, as on the log');
    assert.ok(body.includes('EXISTS (SELECT 1 FROM public.adventure_block b'), 'blocked authors are marked, not left out');
    assert.ok(!body.includes('NOT EXISTS'), 'blocked authors are in the list');
    assert.ok(body.includes('ORDER BY r.created_at DESC, r.id DESC'), 'newest first');
    assert.ok(body.includes('LIMIT least(greatest(coalesce(p_limit, 30), 1), 100);'), 'the clamp');
});

test('no table and no row changes', () => {
    for (const statement of ['CREATE TABLE', 'ALTER TABLE', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'DROP ']) {
        assert.ok(!live.includes(statement), `${statement} has no business in a read`);
    }
});

test('revoked from PUBLIC, then granted to website: two grants', () => {
    const grants = live.match(/^GRANT .*/gm) ?? [];
    assert.equal(grants.length, GRANTED.length);
    for (const signature of GRANTED) {
        const revoke = `REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`;
        const grant = `GRANT EXECUTE ON FUNCTION accounts.${signature} TO website;`;
        assert.ok(live.includes(revoke) && live.includes(grant), signature);
        assert.ok(live.indexOf(revoke) < live.indexOf(grant), `revoke first: ${signature}`);
    }
});

test('the rollback drops both functions and the index', () => {
    for (const signature of GRANTED) {
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${signature};`), `drop ${signature}`);
    }
    assert.ok(rollback.includes('-- DROP INDEX IF EXISTS "adventure_event_directory_idx";'), 'drop the index');
});
