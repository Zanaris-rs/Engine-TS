import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';

import { PLUGIN_ID_BASE, PLUGIN_ID_CEILING, PLUGIN_PACK_TYPES } from '#tools/plugins/PluginIds.js';

/**
 * The ceilings are not preferences - each one is a field width or array bound somewhere in the
 * engine or the client, and every one of them truncates silently rather than erroring. These
 * tests re-derive them from the source, so an engine pull that changes a width fails here instead
 * of quietly placing content under the wrong id.
 *
 * That failure mode is not hypothetical: a loc at id 20000 was masked to 3616 and appeared as an
 * unrelated object, which took a live packet capture to diagnose.
 */
function engineSource(rel: string): string {
    return fs.readFileSync(path.resolve(rel), 'utf8');
}

describe('plugin id ceilings still match the source they were derived from', () => {
    it('loc: Loc packs the type into 14 bits', () => {
        const src = engineSource('src/engine/entity/Loc.ts');
        assert.match(src, /type & 0x3fff/, 'Loc.packInfo no longer masks the type to 14 bits');
        assert.match(src, /return this\.currentInfo & 0x3fff/, 'the loc type getter no longer masks to 14 bits');
        assert.strictEqual(PLUGIN_ID_CEILING.loc, 0x3fff + 1);
    });

    it('npc: the info encoder packs the type into 11 bits', () => {
        const src = engineSource('src/network/rsbuf/info.ts');
        const match = src.match(/pbit\((\d+), ntype\)/);
        assert.ok(match, 'could not find the npc type field in the info encoder');
        assert.strictEqual(PLUGIN_ID_CEILING.npc, 1 << Number(match[1]), `npc type field is now ${match[1]} bits`);
    });

    it('npc: pbit masks rather than throwing, which is why the ceiling matters', () => {
        const src = engineSource('src/network/rsbuf/packet.ts');
        assert.match(src, /pbit\(/);
        assert.doesNotMatch(src.slice(src.indexOf('pbit(')), /^[^}]*throw/, 'pbit now validates, so out-of-range ids would be caught at runtime');
    });

    it('varp: the client stores live values in a fixed array', () => {
        // the client is the binding constraint here, not the 16-bit wire field
        const candidates = ['../Client-Java/src/main/java/jagex2/client/Client.java', '../javaclient/src/main/java/jagex2/client/Client.java'];
        const found = candidates.map(c => path.resolve(c)).find(c => fs.existsSync(c));

        if (!found) {
            return; // client not checked out; nothing to cross-check against
        }

        const match = fs.readFileSync(found, 'utf8').match(/varps = new int\[(\d+)\]/);
        assert.ok(match, 'could not find the client varp array');
        assert.strictEqual(PLUGIN_ID_CEILING.varp, Number(match[1]), `client varp array is now ${match[1]} entries`);
    });
});

describe('plugin id ranges are internally coherent', () => {
    it('every type has a base and a ceiling, and the base leaves room', () => {
        for (const type of PLUGIN_PACK_TYPES) {
            const base = PLUGIN_ID_BASE[type];
            const ceiling = PLUGIN_ID_CEILING[type];

            assert.ok(Number.isInteger(base) && base > 0, `${type} has no usable base`);
            assert.ok(Number.isInteger(ceiling), `${type} has no ceiling`);
            assert.ok(base < ceiling, `${type} base ${base} is not below its ceiling ${ceiling}`);
            assert.ok(ceiling - base >= 128, `${type} has only ${ceiling - base} slots, which is not worth reserving`);
        }
    });

    it('no type exceeds the packer index buffer', () => {
        // PackedData and the versionlist both use Packet.alloc(3) - 100,000 bytes - at 2 bytes
        // per entry, so anything at or above 50,000 throws a RangeError during the build
        for (const type of PLUGIN_PACK_TYPES) {
            assert.ok(PLUGIN_ID_CEILING[type] <= 50000, `${type} ceiling ${PLUGIN_ID_CEILING[type]} exceeds the packer's 50,000 entry limit`);
        }
    });
});
