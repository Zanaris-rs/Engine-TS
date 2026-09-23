import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 10, read back from the file. As with the other migrations, nothing
// in this repo runs it: the Docker rehearsal does, once, before production.
// What must not drift silently - that it answers staff alone, that it adds one
// grant and touches no table - is pinned here.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/10_invite_genealogy/migration.sql');

const ROLLBACK = '\n-- rollback:';
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
const genealogy = defined.get('staff_invite_genealogy');

test('migration 10 defines staff_invite_genealogy and nothing else', () => {
    assert.deepEqual([...defined.keys()], ['staff_invite_genealogy']);
});

test('it is a read: STABLE, SECURITY DEFINER, search_path pinned', () => {
    assert.ok(genealogy);
    assert.ok(genealogy.header.includes('STABLE'), 'STABLE');
    assert.ok(genealogy.header.includes('SECURITY DEFINER'), 'SECURITY DEFINER');
    assert.ok(genealogy.header.includes('SET search_path = public, pg_temp'), 'search_path');
});

test('who invited whom stays staff-only', () => {
    // Migration 6 made it private to the two players and staff. Without this
    // check the whole tree would be one query away for any signed-in player.
    assert.ok(genealogy?.body.includes('WHERE accounts.is_staff(p_actor)'));
});

test('an account claims once, so it appears once', () => {
    assert.ok(genealogy?.body.includes('SELECT DISTINCT ON (i.claimed_by_account_id)'), 'one claim per account');
    assert.ok(genealogy?.body.includes('LEFT JOIN claim'), 'progenitors kept: no claim, null invited_by');
});

test('no LIMIT, which would turn the rows past the cut into false progenitors', () => {
    assert.ok(!genealogy?.body.includes('LIMIT'));
});

test('no table and no row changes', () => {
    for (const statement of ['CREATE TABLE', 'ALTER TABLE', 'CREATE INDEX', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'DROP ']) {
        assert.ok(!live.includes(statement), `${statement} has no business in a read`);
    }
});

test('revoked from PUBLIC, then one grant to website', () => {
    const revoke = 'REVOKE ALL ON FUNCTION accounts.staff_invite_genealogy(text) FROM PUBLIC;';
    const grant = 'GRANT EXECUTE ON FUNCTION accounts.staff_invite_genealogy(text) TO website;';

    assert.ok(live.includes(revoke) && live.includes(grant));
    assert.ok(live.indexOf(revoke) < live.indexOf(grant), 'revoke first');
    assert.equal(live.match(/GRANT /g)?.length, 1, 'one grant');
});

test('the rollback drops the function', () => {
    assert.ok(rollback.includes('-- DROP FUNCTION IF EXISTS accounts.staff_invite_genealogy(text);'));
});
