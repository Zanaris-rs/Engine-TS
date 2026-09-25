import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 5, read back from the file.
//
// Same reason as EvidenceSql.test.ts: nothing in this repo executes any of it.
// The website calls these two functions by name and reads their columns by
// hand, the migration is applied once by a person at a psql prompt, and the
// properties that must not drift silently - who may execute what, which profile
// is readable, how far back a window may reach - are pinned here instead.
//
// This one carries a little more than a readback, because two clauses in
// public_economy_group_range are load-bearing in a way a reader would not guess
// from looking at them: the '*' residual and the CROSS JOIN that fills absent
// groups with a zero. Both are asserted below with the reason attached.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/005_economy_categories/migration.sql');

const ROLLBACK = '\n-- rollback:';
assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');

const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

/** Every function the file defines, keyed by name, with its body. */
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

/** The two functions this migration adds, with the argument list each is REVOKEd and GRANTed by. */
const API: [string, string][] = [
    ['public_economy_latest', ''],
    ['public_economy_group_range', 'int, jsonb']
];

test('migration 5 defines the two read functions and no others', () => {
    assert.deepEqual(
        [...defined.keys()],
        API.map(([name]) => name)
    );
});

test('both functions are SECURITY DEFINER with the search_path pinned', () => {
    for (const [name, { header }] of defined) {
        assert.ok(header.includes('SECURITY DEFINER'), `${name}: SECURITY DEFINER`);
        assert.ok(header.includes('SET search_path = public, pg_temp'), `${name}: search_path`);
        assert.ok(header.includes('LANGUAGE sql STABLE'), `${name}: a read, and declared as one`);
    }
});

test('neither function lets the caller choose which profile is public', () => {
    for (const [name, { body }] of defined) {
        assert.ok(body.includes('es.profile = accounts.public_profile()'), `${name}: pinned to the public profile`);
        assert.ok(!/\bp_profile\b/.test(body), `${name}: takes no profile argument`);
    }
});

test('the window is clamped to the same 1..90 days and 2400 snapshots as public_economy', () => {
    const { body } = defined.get('public_economy_group_range')!;

    assert.ok(body.includes('least(greatest(coalesce(p_days, 30), 1), 90)'), 'clamped, defaulting to 30');
    assert.ok(body.includes('LIMIT 2400'), 'the same ceiling migration 4 put on public_economy');
});

test('the newest census is one row', () => {
    const { body } = defined.get('public_economy_latest')!;

    assert.ok(body.includes('ORDER BY es.taken_at DESC, es.id DESC'), 'newest first, id breaking a tie');
    assert.ok(body.includes('LIMIT 1'), 'one row');
    assert.ok(body.includes('es.items'), 'including the whole item map, which is the point of the function');
});

test('the residual group is summed in SQL, because a minimum is not a subtraction', () => {
    const { body } = defined.get('public_economy_group_range')!;

    // min(other) is not min(everything) - max(named). Deriving the "Other
    // items" low on the website would print a bound and call it a figure, so
    // the ids no group named are summed per snapshot here, in the same pass.
    assert.ok(body.includes("coalesce(m.grp, '*')"), "unmatched ids fall into '*'");
    assert.ok(body.includes("g.key <> '*'"), "and a caller cannot name a group '*' itself");
});

test('an id named twice is counted once, and a group that held nothing has a low of zero', () => {
    const { body } = defined.get('public_economy_group_range')!;

    // The caller's map is meant to be a partition and the website has a test
    // saying so. This is what keeps the groups summing to the census if that
    // test is ever wrong.
    assert.ok(body.includes('SELECT DISTINCT ON (i.value)'), 'one group per id');

    // Without filling every group against every snapshot, a category that was
    // empty for a week would report the low of the hours it happened to exist.
    assert.ok(body.includes('CROSS JOIN named n'), 'every group against every snapshot');
    assert.ok(body.includes('coalesce(p.total, 0)'), 'an hour a group was absent from is a zero');
});

test('every function loses the PUBLIC default before website is granted it', () => {
    for (const [name, args] of API) {
        const revoke = `REVOKE ALL ON FUNCTION accounts.${name}(${args}) FROM PUBLIC;`;
        const grant = `GRANT EXECUTE ON FUNCTION accounts.${name}(${args}) TO website;`;

        assert.ok(live.includes(revoke), `REVOKE ${name}`);
        assert.ok(live.includes(grant), `GRANT ${name}`);
        assert.ok(live.indexOf(revoke) < live.indexOf(grant), `${name}: revoked before granted`);
    }

    const granted = [...live.matchAll(/^GRANT EXECUTE ON FUNCTION accounts\.(\w+)\(([^)]*)\) TO website;$/gm)].map(match => [match[1], match[2]] as [string, string]);

    assert.deepEqual(granted, API);
});

test('the migration grants nothing on a table', () => {
    for (const grant of migration.match(/^GRANT .*/gm) ?? []) {
        assert.ok(grant.includes('ON FUNCTION'), grant);
    }
});

test('the migration creates no table, index or column', () => {
    // The whole claim of this migration is that it publishes what migration 4
    // already collected. A CREATE TABLE here would mean that is no longer true.
    for (const statement of live.match(/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b.*/gm) ?? []) {
        assert.ok(statement.startsWith('CREATE OR REPLACE FUNCTION'), statement);
    }
});

test('the rollback drops both functions and nothing else', () => {
    for (const [name, args] of API) {
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${name}(${args});`), `rollback drops ${name}`);
    }

    // Commented out, like every rollback block in these migrations: it is a
    // note for a person at a psql prompt, not something psql should run.
    for (const line of rollback.split('\n')) {
        assert.ok(line === '' || line.startsWith('--'), `rollback is prose: ${line}`);
    }
});
