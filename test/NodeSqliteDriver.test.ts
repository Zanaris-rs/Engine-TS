import assert from 'node:assert/strict';
import test from 'node:test';

import { bindParameters } from '#/db/dialect/NodeSqliteDriver.js';

test('bindParameters passes through what node:sqlite already understands', () => {
    assert.deepEqual(bindParameters([null, 1, 'main', 12n]), [null, 1, 'main', 12n]);
});

test('bindParameters coerces booleans to 0/1', () => {
    assert.deepEqual(bindParameters([true, false]), [1, 0]);
});

test('bindParameters coerces Date to a UTC datetime string', () => {
    assert.deepEqual(bindParameters([new Date('2026-09-04T18:30:05.123Z')]), ['2026-09-04 18:30:05']);
});

test('bindParameters leaves undefined alone (kysely never binds it, but do not invent a value)', () => {
    assert.deepEqual(bindParameters([undefined]), [undefined]);
});
