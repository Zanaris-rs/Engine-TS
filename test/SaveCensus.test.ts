import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { censusSaves } from '#tools/server/SaveCensus.js';
import { FALLBACK_PERM_INVS, InvLookup } from '#tools/server/SaveReader.js';

const V7 = fs.readFileSync('test/fixtures/save-v7.sav');

const packInvs: InvLookup = (type: number) => FALLBACK_PERM_INVS[type];

// the fixture's three permanent invs hold these, and nothing else counts
const FIXTURE_COINS = 25;
const FIXTURE_IDS = 20;

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
}

/** A save the census will believe has finished being written. */
function settledSave(dir: string, name: string) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, V7);

    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
}

test('sums every permanent inv of every save', async () => {
    const dir = tempDir();
    settledSave(dir, 'alpha.sav');
    settledSave(dir, 'beta.sav');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a save');

    const census = await censusSaves(dir, packInvs);

    assert.equal(census.players, 2);
    assert.equal(census.censused, 2);
    assert.equal(census.items.get(995), FIXTURE_COINS * 2);
    assert.equal(census.items.size, FIXTURE_IDS);
    assert.deepEqual(census.unreadable, []);
    assert.deepEqual(census.unsettled, []);
    assert.equal(census.settled, 0);
});

test('waits for a save that was still being written, and counts it', async () => {
    const dir = tempDir();
    settledSave(dir, 'alpha.sav');
    // written this instant: inside the settle window on the first pass
    fs.writeFileSync(path.join(dir, 'beta.sav'), V7);

    const waits: number[] = [];
    const census = await censusSaves(dir, packInvs, { settleMs: 120, waitMs: 140, onWait: (pending, attempt) => waits.push(pending * 10 + attempt) });

    // one file, one wait, and then it was read - not left out
    assert.deepEqual(waits, [11]);
    assert.equal(census.settled, 1);
    assert.equal(census.censused, 2);
    assert.equal(census.players, 2);
    assert.deepEqual(census.unsettled, []);
    assert.equal(census.items.get(995), FIXTURE_COINS * 2);
});

test('gives up on a save that keeps being written, and says so', async () => {
    const dir = tempDir();
    settledSave(dir, 'alpha.sav');
    fs.writeFileSync(path.join(dir, 'beta.sav'), V7);

    const attempts: number[] = [];
    const census = await censusSaves(dir, packInvs, {
        // the wait is shorter than the window, and the file is written again
        // each time the census comes back to it: a player saving over and over
        settleMs: 400,
        waitMs: 60,
        onWait: (_pending, attempt) => {
            attempts.push(attempt);
            fs.writeFileSync(path.join(dir, 'beta.sav'), V7);
        }
    });

    assert.equal(attempts.length, 2, 'two attempts, then it is left out');
    assert.deepEqual(census.unsettled, ['beta.sav']);
    assert.equal(census.censused, 1);
    assert.equal(census.players, 2);
    assert.equal(census.settled, 0);
    // the caller compares these two to decide whether flow rows are honest
    assert.notEqual(census.censused, census.players);
    assert.equal(census.items.get(995), FIXTURE_COINS);
});

test('a save rewritten under the read is retried rather than counted torn', async () => {
    const dir = tempDir();
    settledSave(dir, 'alpha.sav');

    let reads = 0;
    const realReadFileSync = fs.readFileSync;
    // the file is settled by its mtime, but changes between the read and the
    // check - the race the mtime window alone cannot see
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((file: string, ...rest: unknown[]) => {
        const data = (realReadFileSync as (file: string, ...rest: unknown[]) => Buffer)(file, ...rest);
        if (typeof file === 'string' && file.endsWith('alpha.sav') && reads++ === 0) {
            const now = new Date();
            fs.utimesSync(file, now, now);
        }
        return data;
    }) as typeof fs.readFileSync;

    try {
        const census = await censusSaves(dir, packInvs, { settleMs: 60, waitMs: 80 });

        assert.equal(census.censused, 1);
        assert.equal(census.settled, 1, 'it took a second attempt');
        assert.deepEqual(census.unsettled, []);
    } finally {
        (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = realReadFileSync;
    }
});

test('an unreadable save is reported by name and censused as nothing', async () => {
    const dir = tempDir();
    settledSave(dir, 'alpha.sav');
    fs.writeFileSync(path.join(dir, 'corrupt.sav'), Buffer.from('not a save at all'));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, 'corrupt.sav'), old, old);

    const census = await censusSaves(dir, packInvs);

    assert.equal(census.players, 2);
    assert.equal(census.censused, 1);
    assert.equal(census.unreadable.length, 1);
    assert.match(census.unreadable[0], /^corrupt\.sav: Invalid save file$/);
});

test('the newest save mtime covers files that were waited on', async () => {
    const dir = tempDir();
    settledSave(dir, 'alpha.sav');
    fs.writeFileSync(path.join(dir, 'beta.sav'), V7);

    const census = await censusSaves(dir, packInvs, { settleMs: 120, waitMs: 140 });

    assert.ok(census.newestSave);
    assert.ok(Date.now() - census.newestSave.getTime() < 10_000, 'the just-written save is the newest one');
});
