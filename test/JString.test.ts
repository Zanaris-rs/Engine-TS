import assert from 'node:assert/strict';
import test from 'node:test';

import { fromBase37, toBase37, toDisplayName, toSafeName } from '#/util/JString.js';

test('toSafeName strips trailing underscores, because base37 cannot encode them', () => {
    assert.equal(toSafeName('bob_'), 'bob');
    assert.equal(toSafeName('bob__'), 'bob');
    assert.equal(toSafeName('bo_b'), 'bo_b');
});

test('toSafeName lowercases, and folds anything outside the alphabet to an underscore', () => {
    assert.equal(toSafeName('Bob'), 'bob');
    assert.equal(toSafeName('bob smith'), 'bob_smith');
    // '-' is not in the base37 alphabet, so it encodes as 0, which decodes as '_'
    assert.equal(toSafeName('b-o-b'), 'b_o_b');
});

test('toSafeName truncates at the 12 character boundary', () => {
    assert.equal(toSafeName('abcdefghijkl'), 'abcdefghijkl');
    assert.equal(toSafeName('abcdefghijklm'), 'abcdefghijkl');
});

test('toSafeName is idempotent, so registration can store its own output', () => {
    for (const name of ['bob_', 'Bob', 'abcdefghijklm', 'zzzzzzzzzzzz', 'a1']) {
        assert.equal(toSafeName(toSafeName(name)), toSafeName(name), name);
    }
});

test('an unencodable name becomes invalid_name rather than an empty string', () => {
    assert.equal(toSafeName(''), 'invalid_name');
    assert.equal(toSafeName('___'), 'invalid_name');
    assert.equal(toSafeName('!!!'), 'invalid_name');
    assert.equal(fromBase37(-1n), 'invalid_name');
    // 37 ** 12, one past the last encodable name
    assert.equal(fromBase37(6582952005840035281n), 'invalid_name');
});

test('toBase37 round-trips through fromBase37', () => {
    for (const name of ['bob', 'a', 'the_inducted', 'z9']) {
        assert.equal(fromBase37(toBase37(name)), name);
    }
});

test('toDisplayName is what the hiscores show', () => {
    assert.equal(toDisplayName('the_inducted'), 'The Inducted');
    assert.equal(toDisplayName('bob_'), 'Bob');
});
