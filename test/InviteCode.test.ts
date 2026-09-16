import assert from 'node:assert/strict';
import test from 'node:test';

import { formatInviteCode, generateInviteCode, INVITE_ALPHABET, INVITE_CODE_PATTERN, normalizeInviteCode } from '#/util/InviteCode.js';

// The same vectors are pinned in the website's lib/invite/code.test.ts. Both
// sides mint codes (the site for players, account.ts for staff), and
// migration 6's CHECK constraint is the arbiter both answer to.
const VECTORS: [number[], string][] = [
    [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0], '0000000000000000'],
    [[255, 255, 255, 255, 255, 255, 255, 255, 255, 255], 'ZZZZZZZZZZZZZZZZ'],
    [[1, 0, 0, 0, 0, 0, 0, 0, 0, 0], '0400000000000000'],
    [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], '000G40R40M30E209'],
    [[0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab], 'VTPVXVR14D2PF2DB']
];

test('the alphabet is Crockford base32: no I, L, O or U', () => {
    assert.equal(INVITE_ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    assert.equal(INVITE_CODE_PATTERN.source, '^[0-9A-HJKMNP-TV-Z]{16}$');
    for (const letter of 'ILOU') {
        assert.ok(!INVITE_ALPHABET.includes(letter), letter);
    }
});

test('ten bytes become sixteen characters, most significant bit first', () => {
    for (const [bytes, code] of VECTORS) {
        assert.equal(generateInviteCode(Uint8Array.from(bytes)), code);
    }
});

test('a generated code always matches the database CHECK', () => {
    for (let i = 0; i < 200; i++) {
        assert.match(generateInviteCode(), INVITE_CODE_PATTERN);
    }
});

test('anything but ten bytes is refused', () => {
    assert.throws(() => generateInviteCode(new Uint8Array(9)));
    assert.throws(() => generateInviteCode(new Uint8Array(11)));
});

test('a typed or pasted code is folded back to the stored form', () => {
    assert.equal(normalizeInviteCode('vtpv-xvr1-4d2p-f2db'), 'VTPVXVR14D2PF2DB');
    assert.equal(normalizeInviteCode('  VTPV XVR1 4D2P F2DB '), 'VTPVXVR14D2PF2DB');
    // Crockford's reading rules: I and L are 1, O is 0
    assert.equal(normalizeInviteCode('VTPV-XVRI-4D2P-F2DB'), 'VTPVXVR14D2PF2DB');
    assert.equal(normalizeInviteCode('VTPV-XVRL-4D2P-F2DB'), 'VTPVXVR14D2PF2DB');
    assert.equal(normalizeInviteCode('OOOO-OOOO-OOOO-OOOO'), '0000000000000000');
});

test('anything that cannot be a code is null', () => {
    for (const bad of ['', 'VTPV', 'VTPVXVR14D2PF2DBX', 'UUUUUUUUUUUUUUUU', 'VTPV_XVR1_4D2P_F2DB', '💥'.repeat(16)]) {
        assert.equal(normalizeInviteCode(bad), null, bad);
    }
});

test('a code is shown in four groups of four', () => {
    assert.equal(formatInviteCode('VTPVXVR14D2PF2DB'), 'VTPV-XVR1-4D2P-F2DB');
});
