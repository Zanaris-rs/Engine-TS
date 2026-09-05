import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import Packet from '#/io/Packet.js';
import { FALLBACK_PERM_INVS, InvLookup, InvMeta, readSave, SAV_MAGIC, SAV_VERSION, SCOPE_PERM } from '#tools/server/SaveReader.js';

// the two fixtures are real saves written by the sqlite dev world: save-v7 has
// something in all three permanent invs, save-v7-stacks has stacks past 254,
// which is where the count escape lives.
const V7 = new Uint8Array(fs.readFileSync('test/fixtures/save-v7.sav'));
const V7_STACKS = new Uint8Array(fs.readFileSync('test/fixtures/save-v7-stacks.sav'));

const INV = 93;
const WORN = 94;
const BANK = 95;

const SCOPE_TEMP = 0;

const packInvs: InvLookup = (type: number) => FALLBACK_PERM_INVS[type];

interface BuiltInv {
    type: number;
    size: number;
    // null is an empty slot
    objs: ({ id: number; count: number } | null)[];
}

/**
 * A save built by hand, so the older format versions can be tested without a
 * fixture from an engine nobody runs any more. Mirrors what
 * `PlayerSaving.save` writes for the given version.
 */
function buildSave(version: number, invs: BuiltInv[], { magic = SAV_MAGIC, varps = [0, 0, 0] }: { magic?: number; varps?: number[] } = {}): Uint8Array {
    const buf = new Packet(new Uint8Array(4096));

    buf.p2(magic);
    buf.p2(version);

    buf.p2(3222); // x
    buf.p2(3222); // z
    buf.p1(0); // level
    for (let i = 0; i < 7; i++) {
        buf.p1(0);
    }
    for (let i = 0; i < 5; i++) {
        buf.p1(0);
    }
    buf.p1(0); // gender
    buf.p2(10000); // runenergy

    if (version >= 2) {
        buf.p4(1234);
    } else {
        buf.p2(1234);
    }

    for (let i = 0; i < 21; i++) {
        buf.p4(1154); // exp
        buf.p1(1); // boosted level
    }

    buf.p2(varps.length);
    for (let i = 0; i < varps.length; i++) {
        if (version >= 7) {
            buf.p2(i);
            buf.pVarInt(varps[i]);
        } else {
            buf.p4(varps[i]);
        }
    }

    buf.p1(invs.length);
    for (const inv of invs) {
        buf.p2(inv.type);
        if (version >= 5) {
            buf.p2(inv.size);
        }

        for (let slot = 0; slot < inv.size; slot++) {
            const obj = inv.objs[slot] ?? null;
            if (!obj) {
                buf.p2(0);
                continue;
            }

            buf.p2(obj.id + 1);
            if (obj.count >= 255) {
                buf.p1(255);
                buf.p4(obj.count);
            } else {
                buf.p1(obj.count);
            }
        }
    }

    if (version >= 3) {
        buf.p1(0); // afk zones
        buf.p2(0); // last afk zone
    }

    if (version >= 4) {
        buf.p1(0); // packed chat modes
    }

    if (version >= 6) {
        buf.p8(0n); // last login time
    }

    const data = buf.data.subarray(0, buf.pos + 4);
    const crc = Packet.getcrc(data, 0, buf.pos);
    buf.p4(crc);

    return data;
}

test('reads the permanent inventories out of a v7 save', () => {
    const save = readSave('d', V7, packInvs);

    assert.equal(save.username, 'd');
    assert.equal(save.version, 7);
    assert.deepEqual(Object.keys(save.inventories).map(Number), [INV, WORN, BANK]);
    assert.deepEqual(save.inventories[WORN], [{ id: 20000, count: 1 }]);
    assert.deepEqual(save.inventories[BANK], [{ id: 995, count: 25 }]);
    // empty slots take no count byte, so the backpack is the 18 things in it
    assert.equal(save.inventories[INV].length, 18);
    assert.deepEqual(save.inventories[INV][0], { id: 1351, count: 1 });
    assert.deepEqual(save.inventories[INV].at(-1), { id: 559, count: 2 });
});

test('reads stacks past the 254 count escape', () => {
    const save = readSave('matt', V7_STACKS, packInvs);

    assert.deepEqual(save.inventories[INV], [
        { id: 556, count: 460 },
        { id: 558, count: 375 },
        { id: 562, count: 60 },
        { id: 995, count: 790 }
    ]);
    // an inv that is present but empty stays present and empty
    assert.deepEqual(save.inventories[WORN], []);
    assert.equal(save.inventories[BANK].length, 37);
    assert.deepEqual(
        save.inventories[BANK].find(obj => obj.id === 52),
        { id: 52, count: 1355 }
    );
});

test('drops inventories that are not permanent scope', () => {
    // nothing about the filter is hardcoded to the bank's id: change its scope
    // and the census stops seeing it
    const notPermanent: InvLookup = (type: number) => (type === BANK ? { size: 240, scope: SCOPE_TEMP } : FALLBACK_PERM_INVS[type]);

    const save = readSave('d', V7, notPermanent);

    assert.deepEqual(Object.keys(save.inventories).map(Number), [INV, WORN]);
});

test('drops inventories the cache config has never heard of', () => {
    const save = readSave('d', V7, () => undefined);

    assert.deepEqual(save.inventories, {});
});

test('an empty save owns nothing', () => {
    const save = readSave('newbie', new Uint8Array(0), packInvs);

    assert.equal(save.version, 0);
    assert.deepEqual(save.inventories, {});
});

test('rejects a file that is not a save', () => {
    assert.throws(() => readSave('d', buildSave(7, [], { magic: 0x1234 }), packInvs), /Invalid save file/);
});

test('rejects a save from a newer engine', () => {
    assert.throws(() => readSave('d', buildSave(SAV_VERSION + 1, [], {}), packInvs), /Unsupported save version/);
});

test('rejects a corrupt save rather than counting half of it', () => {
    const corrupt = new Uint8Array(V7);
    corrupt[200] ^= 0xff;

    assert.throws(() => readSave('d', corrupt, packInvs), /Incorrect save checksum/);
});

test('takes inv sizes from the config below version 5, and from the file above it', () => {
    const objs = [{ id: 995, count: 300 }, null, { id: 1038, count: 1 }];
    const meta: InvMeta = { size: 3, scope: SCOPE_PERM };
    const invs: InvLookup = (type: number) => (type === INV ? meta : undefined);

    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
        const save = readSave('d', buildSave(version, [{ type: INV, size: 3, objs }], {}), invs);

        assert.equal(save.version, version, `version ${version}`);
        assert.deepEqual(
            save.inventories[INV],
            [
                { id: 995, count: 300 },
                { id: 1038, count: 1 }
            ],
            `version ${version}`
        );
    }
});

test('refuses to guess an inv size in a save too old to record one', () => {
    const save = buildSave(4, [{ type: INV, size: 3, objs: [{ id: 995, count: 1 }, null, null] }], {});

    assert.throws(() => readSave('d', save, () => undefined), /Unknown inv 93 in a version 4 save/);
});
