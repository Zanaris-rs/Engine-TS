import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 9, read back from the file.
//
// Same reason as the other *Sql tests: nothing in this repo executes any of
// it. The migration is applied once by a person at a psql prompt, onto a
// database that already has migration 8, and the properties that must not
// drift silently are pinned here.
//
// Two of them are contract rather than readback. The header has to be
// migration 8's character for character: CREATE OR REPLACE cannot change a
// function's return type, so a drifted RETURNS TABLE would fail at the prompt
// rather than here, and any other drift would be a second change riding in on
// a one-line one. And migration 8's record_stop has to go on reading
// the grace from record_durations() - that is what makes this one line the
// whole change, and an attempt already running when it lands judged by it.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/9_record_grace/migration.sql');
const migration8 = read('../prisma/postgres/migrations/8_records/migration.sql');

const ROLLBACK = '\n-- rollback:';
assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');
assert.ok(migration8.includes(ROLLBACK), 'and migration 8 has one too');

const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));
const live8 = migration8.slice(0, migration8.indexOf(ROLLBACK));

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
const defined8 = functions(live8);

/** The rollback with each line's comment marker taken off, so it reads as the SQL it would run. */
const uncommented = rollback
    .split('\n')
    .map(line => line.replace(/^-- ?/, ''))
    .join('\n');

test('migration 9 defines record_durations and nothing else', () => {
    assert.deepEqual([...defined.keys()], ['record_durations']);
});

test('the grace is two seconds, and five minutes is still the only duration', () => {
    assert.equal(defined.get('record_durations')!.body.trim(), 'VALUES (300, 2);');
});

test("the header is migration 8's, character for character", () => {
    // CREATE OR REPLACE cannot change a return type, and anything else that
    // differed - volatility, SECURITY DEFINER, the search_path - would be a
    // second change riding in on a one-line one.
    const header = defined.get('record_durations')!.header;
    const header8 = defined8.get('record_durations')?.header;

    assert.ok(header8, 'migration 8 defines record_durations');
    assert.equal(header, header8);
    assert.ok(header.includes('RETURNS TABLE (duration_seconds int, grace_seconds int)'), 'the columns the site and record_stop read');
    assert.ok(header.includes('LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS'), 'the same attributes');
});

test('website keeps its grant, revoked from PUBLIC first, and gains nothing', () => {
    const revoke = 'REVOKE ALL ON FUNCTION accounts.record_durations() FROM PUBLIC;';
    const grant = 'GRANT EXECUTE ON FUNCTION accounts.record_durations() TO website;';

    assert.ok(live.includes(revoke), 'REVOKE record_durations');
    assert.ok(live.includes(grant), 'GRANT record_durations');
    assert.ok(live.indexOf(revoke) < live.indexOf(grant), 'revoked before granted');

    assert.deepEqual(live.match(/^GRANT .*/gm), [grant], 'the one grant, on the one function');
    assert.deepEqual(live.match(/^REVOKE .*/gm), [revoke], 'the one revoke, on the one function');
});

test('the migration changes no table and no row', () => {
    for (const statement of live.match(/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b.*/gm) ?? []) {
        assert.ok(statement.startsWith('CREATE OR REPLACE FUNCTION accounts.record_durations()'), statement);
    }
});

test("the rollback is all comments and puts migration 8's ten seconds back", () => {
    for (const line of rollback.split('\n')) {
        assert.ok(line === '' || line.startsWith('--'), `rollback line is a comment: ${line}`);
    }

    const restored = functions(uncommented).get('record_durations');
    assert.ok(restored, 'the rollback redefines record_durations');
    assert.equal(restored.body.trim(), 'VALUES (300, 10);');
    assert.equal(restored.body.trim(), defined8.get('record_durations')!.body.trim(), "migration 8's body exactly");
    assert.equal(restored.header, defined8.get('record_durations')!.header, "under migration 8's header");
});

test('record_durations is the only place the grace lives', () => {
    // Migration 8's Stop reads the grace from record_durations() at Stop time,
    // and its polled read joins it. If either ever carried its own number, this
    // migration would change what the page says and not what Stop enforces -
    // or the other way round.
    const stop = defined8.get('record_stop')!.body;
    const current = defined8.get('record_current')!.body;

    assert.ok(stop.includes('SELECT d.grace_seconds INTO v_grace FROM accounts.record_durations() d WHERE d.duration_seconds = v_duration;'), 'Stop reads the grace');
    assert.ok(stop.includes('IF v_elapsed > (v_duration + coalesce(v_grace, 0))::bigint * 1000 THEN'), 'and judges by it');
    assert.ok(current.includes('LEFT JOIN accounts.record_durations() d ON d.duration_seconds = ra.duration_seconds;'), 'the polled read joins it');

    // And nothing since has redefined either of them to say otherwise.
    const dir = new URL('../prisma/postgres/migrations/', import.meta.url);
    for (const name of readdirSync(dir)) {
        if (name === 'migration_lock.toml' || name === '8_records') {
            continue;
        }

        const sql = read(`../prisma/postgres/migrations/${name}/migration.sql`);
        const redefined = [...functions(sql.slice(0, sql.includes(ROLLBACK) ? sql.indexOf(ROLLBACK) : sql.length)).keys()];

        assert.ok(!redefined.includes('record_stop'), `${name} redefines record_stop`);
        assert.ok(!redefined.includes('record_current'), `${name} redefines record_current`);
    }
});
