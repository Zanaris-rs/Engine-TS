import assert from 'node:assert/strict';
import test from 'node:test';

import { checkPassword, checkUsername, ipGroup, isValidEmail, normalizeEmail } from '#/util/Account.js';

test('checkUsername returns the name as it will be stored', () => {
    assert.deepEqual(checkUsername('Bob'), { ok: true, username: 'bob' });
    assert.deepEqual(checkUsername('bob smith'), { ok: true, username: 'bob_smith' });
});

test('checkUsername canonicalises rather than surprises: bob_ is bob', () => {
    assert.deepEqual(checkUsername('bob_'), { ok: true, username: 'bob' });
    assert.deepEqual(checkUsername('BOB__'), { ok: true, username: 'bob' });
});

test('checkUsername rejects names base37 cannot carry', () => {
    const empty = checkUsername('');
    assert.equal(empty.ok, false);

    const tooLong = checkUsername('abcdefghijklm');
    assert.equal(tooLong.ok, false);

    const punctuation = checkUsername('bob!');
    assert.equal(punctuation.ok, false);
});

test('checkUsername flags staff impersonation separately, so the CLI can override it', () => {
    for (const name of ['mod_matt', 'jagex', 'admin', 'jmod']) {
        const result = checkUsername(name);
        assert.equal(result.ok, false, name);
        assert.equal(result.ok === false && result.reserved, true, name);
    }

    const ordinary = checkUsername('bob!');
    assert.equal(ordinary.ok === false && ordinary.reserved, false);
});

test('checkPassword holds the 8-20 range', () => {
    assert.equal(checkPassword('hunter2!').ok, true);
    assert.equal(checkPassword('hunter2').ok, false);
    assert.equal(checkPassword('h'.repeat(21)).ok, false);
});

test('normalizeEmail folds case, +tags and gmail dots', () => {
    assert.equal(normalizeEmail('  Bob.Smith+spam@Gmail.com '), 'bobsmith@gmail.com');
    assert.equal(normalizeEmail('bob.smith@example.com'), 'bob.smith@example.com');
    assert.equal(normalizeEmail('bob+one@example.com'), 'bob@example.com');
    assert.equal(normalizeEmail('a.b@googlemail.com'), 'ab@googlemail.com');
});

test('isValidEmail is a shape check, not a verification', () => {
    assert.equal(isValidEmail('bob@example.com'), true);
    assert.equal(isValidEmail('bob@localhost'), false);
    assert.equal(isValidEmail('bob example.com'), false);
    assert.equal(isValidEmail('bob@'), false);
});

test('ipGroup is the /24 for v4 and the /64 for v6', () => {
    assert.equal(ipGroup('203.0.113.42'), '203.0.113.0/24');
    assert.equal(ipGroup('::ffff:203.0.113.42'), '203.0.113.0/24');
    assert.equal(ipGroup('2001:db8:1234:5678:9abc:def0:1234:5678'), '2001:0db8:1234:5678::/64');
    assert.equal(ipGroup('2001:db8::1'), '2001:0db8:0000:0000::/64');
});
