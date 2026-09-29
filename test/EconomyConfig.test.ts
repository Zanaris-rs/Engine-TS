import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The census reads this by hand every hour on the hub, and it is edited by hand
// too - a stray comma or a duplicated id would only surface as a timer that
// stopped writing snapshots, hours after whoever edited it went to bed.
const config = JSON.parse(fs.readFileSync('data/config/economy.json', 'utf8'));

test('the tracked-item list is a list of ids with names', () => {
    assert.ok(Array.isArray(config.tracked), 'tracked must be an array');
    assert.ok(config.tracked.length > 0, 'tracked must not be empty');

    for (const item of config.tracked) {
        assert.equal(typeof item.name, 'string', `${JSON.stringify(item)} needs a name`);
        assert.ok(item.name.length > 0, `${JSON.stringify(item)} needs a name`);
        assert.ok(Number.isInteger(item.id) && item.id >= 0, `${JSON.stringify(item)} needs an integer id`);
    }
});

test('no item is tracked twice', () => {
    const ids = config.tracked.map((item: { id: number }) => item.id);

    assert.deepEqual(ids, [...new Set(ids)]);
});

test('the holiday items the plan named are on it', () => {
    const ids = new Set(config.tracked.map((item: { id: number }) => item.id));

    // partyhats 1038-1048 (odd ids are the cert versions, which nothing in
    // content links to), santa hat, the three h'ween masks, cracker, disk of
    // returning, half full wine jug, pumpkin, easter egg
    for (const id of [1038, 1040, 1042, 1044, 1046, 1048, 1050, 1053, 1055, 1057, 962, 981, 1989, 1959, 1961]) {
        assert.ok(ids.has(id), `item ${id} is not tracked`);
    }
});

test('coins are not tracked twice: economy_snapshot.coins is their column', () => {
    const ids = config.tracked.map((item: { id: number }) => item.id);

    assert.ok(!ids.includes(995));
});
