import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 7, read back from the file.
//
// Same reason as EvidenceSql.test.ts and EconomyCategoriesSql.test.ts: nothing
// in this repo executes any of it. The website calls these two functions by
// name, the migration is applied once by a person at a psql prompt, and the
// properties that must not drift silently are pinned here instead.
//
// Two of the assertions below are not readback but contract. /economy
// headlines "0 items ever created by staff", and that sentence is only true
// while (a) public_staff_spawn_total answers with a row rather than with
// nothing when the table is empty, and (b) nothing ever deletes from
// staff_spawn. Neither property is visible from reading the function, so both
// are asserted with the reason attached.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/7_staff_spawn_total/migration.sql');
const migration4 = read('../prisma/postgres/migrations/4_evidence_and_records/migration.sql');
const migration6 = read('../prisma/postgres/migrations/6_invites/migration.sql');

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

/** The two functions this migration adds. Neither takes an argument, which is the whole point. */
const API: [string, string][] = [
    ['public_staff_spawn_total', ''],
    ['public_staff_spawns_all', '']
];

test('migration 7 defines the two read functions and no others', () => {
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

test('neither function takes an argument, clamps a window or caps a count', () => {
    // Migration 4's public_staff_spawns(p_days) clamps to 1..90 days and stops
    // at 500 rows, silently on both counts. These two exist because "ever" is
    // not a window, so an argument to narrow or a ceiling to truncate would be
    // the same bug wearing a different number.
    for (const [name, { header, body }] of defined) {
        assert.ok(header.includes(`accounts.${name}()`), `${name}: no argument`);
        assert.ok(!body.includes('make_interval'), `${name}: no window`);
        assert.ok(!body.includes('LIMIT'), `${name}: no ceiling`);
        assert.ok(!body.includes('WHERE'), `${name}: nothing filtered out`);
        assert.ok(!/\bp_\w+/.test(body), `${name}: no caller-supplied anything`);
    }
});

test('the total is one row even when the table is empty', () => {
    const { body } = defined.get('public_staff_spawn_total')!;

    // This is the assertion the page rests on. An ungrouped aggregate over an
    // empty table is one row by definition - 0, 0, null, null - and the
    // website needs that row to tell "nothing has ever happened" apart from
    // "the read failed", which are different sentences there. A GROUP BY would
    // turn the first into zero rows, which is the second; it would look like
    // tidying, and nothing about a non-empty answer would change to show it.
    assert.ok(!body.includes('GROUP BY'), 'no GROUP BY: an empty table must still answer with a row');
    assert.ok(body.includes('count(*) AS spawns'), 'how many spawns');
    assert.ok(body.includes('coalesce(sum(ss.count), 0)::bigint AS items'), 'how many items, 0 rather than null when there are none');
    assert.ok(body.includes('min(ss.created_at) AS first_at'), 'when the first was');
    assert.ok(body.includes('max(ss.created_at) AS last_at'), 'when the last was');
});

test('the all-time list is every row, newest first, in the shape the windowed read returns', () => {
    const { header, body } = defined.get('public_staff_spawns_all')!;
    const windowed = functions(migration4.slice(0, migration4.indexOf(ROLLBACK))).get('public_staff_spawns')!;

    // The website parses one shape whichever of the two it called, so the
    // columns and their order are migration 4's, verbatim.
    assert.equal(header.slice(header.indexOf('RETURNS TABLE')), windowed.header.slice(windowed.header.indexOf('RETURNS TABLE')));
    assert.ok(body.includes('SELECT ss.created_at, ss.item_id, ss.count, ss.world'), 'the same four columns');
    assert.ok(body.includes('ORDER BY ss.created_at DESC, ss.id DESC'), 'newest first, id breaking a tie');
});

test('no public function returns an issuer, an account or an address', () => {
    // The same list EvidenceSql.test.ts pins on migration 4's public reads. An
    // unbounded read is where naming somebody would be easiest to do by
    // accident, so it is checked here too rather than assumed to carry over.
    const forbidden = ['issued_by_account_id', 'lifted_by_account_id', 'account_id', 'staff_account_id', 'target_account_id', 'registration_ip', /\bip\b/];

    for (const [name, { header, body }] of defined) {
        for (const needle of forbidden) {
            const found = typeof needle === 'string' ? body.includes(needle) : needle.test(body);
            assert.ok(!found, `${name} mentions ${needle}`);
        }

        // And nothing joins to account, which is the only table that could
        // turn an id back into a name.
        assert.ok(!body.includes('public.account'), `${name} does not read account`);
        assert.ok(!header.includes('username'), `${name} returns no name`);
    }
});

test('nothing reaps the spawn log, which is what lets the page say "ever"', () => {
    // A public "ever" is only true while nothing removes rows behind it. The
    // property is an absence rather than a guard - reap() simply never
    // mentioned this table - so it is asserted here, where a retention rule
    // added later fails a test instead of quietly making the page lie.
    const reap4 = functions(migration4.slice(0, migration4.indexOf(ROLLBACK))).get('reap')!;
    const reap6 = functions(migration6.slice(0, migration6.indexOf(ROLLBACK))).get('reap')!;

    assert.ok(!reap4.body.includes('staff_spawn'), "migration 4's reaper leaves the spawn log alone");
    assert.ok(!reap6.body.includes('staff_spawn'), "migration 6's reaper leaves it alone too");
    assert.ok(!live.includes('DELETE FROM'), 'and migration 7 deletes nothing itself');
});

test('the windowed read is left defined and left granted', () => {
    // The website falls back to public_staff_spawns(int) until this migration
    // has been applied by hand, and the rollback below needs it already there.
    assert.ok(!defined.has('public_staff_spawns'), 'migration 7 does not redefine it');
    assert.ok(!/^(REVOKE|GRANT)\b.*accounts\.public_staff_spawns\(/m.test(live), 'and does not touch its grant');

    assert.ok(migration4.includes('GRANT EXECUTE ON FUNCTION accounts.public_staff_spawns(int) TO website;'), 'migration 4 still grants it');
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
    // The claim of this migration is that it publishes what migration 4
    // already collected, under no window. A CREATE TABLE here would mean that
    // is no longer true.
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
