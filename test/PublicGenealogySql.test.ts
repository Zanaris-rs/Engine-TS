import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 19, read back from the file. As with the other migrations, nothing
// in this repo runs it: the Docker rehearsal does, once, before production.
// What must not drift silently - which columns go public, that it adds one
// grant and touches no table - is pinned here.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/019_public_genealogy/migration.sql');

const ROLLBACK = '\n-- rollback:';
assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');

const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

const earlier = readdirSync(new URL('../prisma/postgres/migrations', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{3}_/.test(entry.name) && entry.name < '019_')
    .map(entry => entry.name)
    .sort()
    .map(name => read(`../prisma/postgres/migrations/${name}/migration.sql`));

function replay(sql: string, granted: ReadonlySet<string>): Set<string> {
    const after = new Set(granted);
    for (const [, verb, signature, role] of sql.matchAll(/^(GRANT|REVOKE|DROP) [A-Z ]*?accounts\.(.+?)(?: (?:TO|FROM) (\w+))?;$/gm)) {
        if (verb === 'GRANT' && role === 'website') {
            after.add(signature);
        } else if ((verb === 'REVOKE' && role === 'website') || verb === 'DROP') {
            after.delete(signature);
        }
    }
    return after;
}

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
const genealogy = defined.get('public_invite_genealogy');

test('migration 19 defines public_invite_genealogy and nothing else', () => {
    assert.deepEqual([...defined.keys()], ['public_invite_genealogy']);
});

test('it is a read: STABLE, SECURITY DEFINER, search_path pinned', () => {
    assert.ok(genealogy);
    assert.ok(genealogy.header.includes('STABLE'), 'STABLE');
    assert.ok(genealogy.header.includes('SECURITY DEFINER'), 'SECURITY DEFINER');
    assert.ok(genealogy.header.includes('SET search_path = public, pg_temp'), 'search_path');
});

test('only the four public columns, and none of the staff ones', () => {
    // Who invited whom is public now; whether an account may invite, and the
    // rest of the account row, are not.
    assert.ok(genealogy?.header.includes('RETURNS TABLE (username text, citizen_number int, invited_by int, joined_at timestamptz)'));
    for (const column of ['invites_enabled', 'banned', 'email', 'password', 'ip', 'staffmodlevel']) {
        assert.ok(!genealogy?.body.includes(column), `${column} stays out`);
    }
});

test('it takes no actor and asks no staff check: it is the public tree', () => {
    assert.ok(genealogy?.header.includes('public_invite_genealogy()'));
    assert.ok(!genealogy?.body.includes('is_staff'));
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

test('revoked from PUBLIC, then one grant to website: 107 to 108', () => {
    const revoke = 'REVOKE ALL ON FUNCTION accounts.public_invite_genealogy() FROM PUBLIC;';
    const grant = 'GRANT EXECUTE ON FUNCTION accounts.public_invite_genealogy() TO website;';

    assert.ok(live.includes(revoke) && live.includes(grant));
    assert.ok(live.indexOf(revoke) < live.indexOf(grant), 'revoke first');
    assert.equal(live.match(/GRANT /g)?.length, 1, 'one grant');

    const was = earlier.reduce((granted: ReadonlySet<string>, sql) => replay(sql, granted), new Set<string>());
    assert.equal(was.size, 107, '000..018 leave the website one hundred and seven functions');
    assert.equal(replay(live, was).size, 108, 'and this one takes it to one hundred and eight');
    const header = live.slice(0, live.indexOf('\n\n')).replace(/\n--\s?/g, ' ');
    assert.ok(header.includes('The `website` role goes from one hundred and seven functions to one hundred and eight.'), 'the header says so');
});

test('the rollback drops the function', () => {
    assert.ok(rollback.includes('-- DROP FUNCTION IF EXISTS accounts.public_invite_genealogy();'));
});
