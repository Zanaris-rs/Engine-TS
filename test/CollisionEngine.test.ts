import assert from 'node:assert/strict';
import test from 'node:test';

import CollisionEngine from '#/engine/routefinder/CollisionEngine.js';
import { CollisionFlag } from '#/engine/routefinder/flags.js';

// An unallocated zone is off-map and reads as blocked; an allocated one with no
// flags is walkable. Collapsing empty zones onto a shared array must not blur
// that distinction - if it did, either the world's empty ground becomes
// impassable or the void becomes walkable.
test('an unallocated zone reads as NULL, an allocated empty one as OPEN', () => {
    const collision = new CollisionEngine();

    assert.equal(collision.isZoneAllocated(100, 100, 0), false);
    assert.equal(collision.get(100, 100, 0), CollisionFlag.NULL);

    collision.allocateIfAbsent(100, 100, 0);

    assert.equal(collision.isZoneAllocated(100, 100, 0), true);
    assert.equal(collision.get(100, 100, 0), CollisionFlag.OPEN);
    assert.equal(collision.isFlagged(100, 100, 0, CollisionFlag.FLOOR), false);
});

test('allocating a zone twice does not clear flags already written to it', () => {
    const collision = new CollisionEngine();

    collision.add(12, 12, 0, CollisionFlag.FLOOR);
    collision.allocateIfAbsent(12, 12, 0);

    assert.equal(collision.get(12, 12, 0), CollisionFlag.FLOOR);
});

test('removing from an absent zone allocates it, as it did before', () => {
    const collision = new CollisionEngine();

    collision.remove(200, 200, 0, CollisionFlag.FLOOR);

    assert.equal(collision.isZoneAllocated(200, 200, 0), true);
    assert.equal(collision.get(200, 200, 0), CollisionFlag.OPEN);
});

test('add then remove returns the tile to OPEN and keeps the zone allocated', () => {
    const collision = new CollisionEngine();

    collision.add(5, 5, 1, CollisionFlag.WALL_NORTH);
    assert.equal(collision.get(5, 5, 1), CollisionFlag.WALL_NORTH);

    collision.remove(5, 5, 1, CollisionFlag.WALL_NORTH);
    assert.equal(collision.get(5, 5, 1), CollisionFlag.OPEN);
    assert.equal(collision.isZoneAllocated(5, 5, 1), true);
});

// The failure mode a shared empty zone invites: a write leaking into every other
// zone that has not been written to yet.
test('a write in one zone does not appear in another empty zone', () => {
    const collision = new CollisionEngine();

    collision.allocateIfAbsent(0, 0, 0);
    collision.allocateIfAbsent(64, 64, 0);

    collision.add(3, 3, 0, CollisionFlag.FLOOR);

    assert.equal(collision.get(3, 3, 0), CollisionFlag.FLOOR);
    // same tile index within its own zone, different zone
    assert.equal(collision.get(67, 67, 0), CollisionFlag.OPEN);
    // and a zone that was never touched at all
    assert.equal(collision.get(131, 131, 0), CollisionFlag.NULL);
});

test('writing a zero mask allocates without flagging anything', () => {
    const collision = new CollisionEngine();

    collision.add(9, 9, 0, 0);
    assert.equal(collision.isZoneAllocated(9, 9, 0), true);
    assert.equal(collision.get(9, 9, 0), CollisionFlag.OPEN);

    collision.set(17, 17, 0, 0);
    assert.equal(collision.isZoneAllocated(17, 17, 0), true);
    assert.equal(collision.get(17, 17, 0), CollisionFlag.OPEN);
});

test('set overwrites rather than merging, including back to zero', () => {
    const collision = new CollisionEngine();

    collision.add(21, 21, 0, CollisionFlag.FLOOR);
    collision.set(21, 21, 0, CollisionFlag.ROOF);
    assert.equal(collision.get(21, 21, 0), CollisionFlag.ROOF);

    collision.set(21, 21, 0, 0);
    assert.equal(collision.get(21, 21, 0), CollisionFlag.OPEN);
});

test('levels are independent', () => {
    const collision = new CollisionEngine();

    collision.add(40, 40, 0, CollisionFlag.FLOOR);

    assert.equal(collision.get(40, 40, 0), CollisionFlag.FLOOR);
    assert.equal(collision.get(40, 40, 1), CollisionFlag.NULL);
});
