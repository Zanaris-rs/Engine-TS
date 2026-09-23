import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 9, read back from the file.
//
// Same reason as RecordsSql.test.ts: nothing in this repo executes any of it.
// The website calls `record_durations` by name, the migration is applied once
// by a person at a psql prompt, and the properties that must not drift
// silently are pinned here.
//
// Three of the assertions below are not readback but contract, and carry their
// reason with them: that migration 8 is what refuses a duration this list does
// not have, that its abandoned cutoff is measured from the duration rather
// than from five minutes, and that no other migration takes the number 9 - the
// closed grace branch (`9_record_grace`) also replaces this one function, so
// two files numbered 9 would mean whichever was applied second silently won.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/9_record_durations/migration.sql');
const migration8 = read('../prisma/postgres/migrations/8_records/migration.sql');

const ROLLBACK = '\n-- rollback:';
assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');

const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

/** Every function the file defines, keyed by name, with its header and body. */
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

test('migration 9 replaces record_durations and defines nothing else', () => {
    assert.deepEqual([...defined.keys()], ['record_durations']);
});

test("the header is migration 8's, so CREATE OR REPLACE swaps the body and nothing else", () => {
    // A changed signature, return type or attribute would not replace migration
    // 8's function: postgres would refuse the return type at the prompt, and a
    // different argument list would leave two functions and grants on one.
    const mine = defined.get('record_durations');
    const theirs = functions(migration8).get('record_durations');

    assert.ok(mine && theirs, 'both files define it');
    assert.equal(mine.header, theirs.header);
});

test('five minutes, six hours and a day, with ten seconds of grace each', () => {
    // 21600 is six hours and 86400 is a day. The website's lib/records/durations.ts
    // owns the words for them, and its `npm run db:check` asserts the two lists agree.
    assert.ok(defined.get('record_durations')?.body.includes('VALUES (300, 10), (21600, 10), (86400, 10);'));
});

test('the five-minute row keeps the grace migration 8 gave it', () => {
    // Website#14 put the site back to ten after the two-second migration was
    // closed unapplied. Adding durations must not quietly re-open that.
    const mine = defined.get('record_durations')?.body ?? '';
    assert.ok(mine.includes('(300, 10)'), 'five minutes still has ten seconds');
    assert.ok(!/\(300,\s*(?!10\b)\d+\)/.test(mine), 'and no other grace for five minutes');
});

test('no table and no row changes', () => {
    for (const statement of ['CREATE TABLE', 'ALTER TABLE', 'CREATE INDEX', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'DROP ']) {
        assert.ok(!live.includes(statement), `${statement} has no business in a durations change`);
    }
});

test('the grant is migration 8s, restated, so the website role stays at fifty-two functions', () => {
    assert.ok(live.includes('REVOKE ALL ON FUNCTION accounts.record_durations() FROM PUBLIC;'));
    assert.ok(live.includes('GRANT EXECUTE ON FUNCTION accounts.record_durations() TO website;'));
    assert.equal(live.match(/GRANT /g)?.length, 1, 'one grant: this migration adds no function');
});

test('migration 8 is what refuses a duration this list does not have', () => {
    // The whole change is a row in this function. It is only the whole change
    // while Start asks this list rather than carrying five minutes of its own.
    const start = functions(migration8).get('record_start')?.body ?? '';

    assert.ok(
        start.includes('IF NOT EXISTS (SELECT 1 FROM accounts.record_durations() d WHERE d.duration_seconds = p_duration_seconds) THEN'),
        'Start asks the durations table'
    );
    assert.ok(start.includes("RETURN QUERY SELECT 'unknown_duration'::text"), 'and refuses anything else');
});

test('the abandoned cutoff is measured from the duration, so a day-long attempt gets a day', () => {
    // An hour past the window, whatever the window was - not an hour past five
    // minutes. Nothing else in migration 8 hard-codes a duration.
    const stale = functions(migration8).get('record_stale')?.body ?? '';

    assert.ok(stale.includes("p_started_at + make_interval(secs => p_duration_seconds) + interval '1 hour'"));
});

test('no two migrations take the same number', () => {
    // `9_record_grace` is a closed branch that replaces this same function. If
    // it is ever revived it has to be renumbered and rebuilt on top of this
    // one, or whichever is applied second wins and the other vanishes.
    const numbers = readdirSync(new URL('../prisma/postgres/migrations', import.meta.url), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name.split('_')[0]);

    assert.equal(new Set(numbers).size, numbers.length, `two migrations share a number: ${numbers.join(', ')}`);
});

test('the rollback puts migration 8s one row back', () => {
    assert.ok(rollback.includes('VALUES (300, 10);'), 'five minutes alone, ten seconds of grace');
    assert.ok(rollback.includes('CREATE OR REPLACE FUNCTION accounts.record_durations()'), 'by replacing the body again');
});
