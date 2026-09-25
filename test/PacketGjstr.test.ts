import assert from 'node:assert/strict';
import test from 'node:test';

import Packet from '#/io/Packet.js';

// The implementation gjstr replaced: a per-character `+=` over a DataView. Kept
// here as the oracle for the fuzz test below, so the flat-decode rewrite has to
// stay byte-for-byte identical to the loop it came from. It reads the same bytes
// a Packet would, rather than reaching into Packet's private view.
function legacyGjstr(bytes: Uint8Array, start: number, terminator: number): { value: string; pos: number } {
    const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length: number = view.byteLength;
    let pos: number = start;
    let str: string = '';
    let b: number;
    while ((b = view.getUint8(pos++)) !== terminator && pos < length) {
        str += String.fromCharCode(b);
    }
    return { value: str, pos };
}

test('gjstr stops at the terminator and consumes it', () => {
    const packet = new Packet(Uint8Array.from([104, 105, 10, 122]));
    assert.equal(packet.gjstr(), 'hi');
    assert.equal(packet.pos, 3);
});

test('gjstr honours a custom terminator', () => {
    const packet = new Packet(Uint8Array.from([104, 105, 0, 122, 122, 122]));
    assert.equal(packet.gjstr(0), 'hi');
    assert.equal(packet.pos, 3);
});

test('gjstr returns empty when the terminator is the first byte', () => {
    const packet = new Packet(Uint8Array.from([10, 65, 66]));
    assert.equal(packet.gjstr(), '');
    assert.equal(packet.pos, 1);
});

// The `&&` in the old loop short-circuited after reading the final byte but
// before appending it, so an unterminated string loses its last character. That
// is load-bearing: the cache is decoded with it.
test('gjstr drops the final byte when no terminator is found', () => {
    const packet = new Packet(Uint8Array.from([65, 66, 67]));
    assert.equal(packet.gjstr(), 'AB');
    assert.equal(packet.pos, 3);
});

test('gjstr reads through a non-zero byteOffset', () => {
    const buffer = new ArrayBuffer(8);
    const window = new Uint8Array(buffer, 3, 4);
    window.set([72, 73, 10, 88]);

    const packet = new Packet(window);
    assert.equal(packet.gjstr(), 'HI');
    assert.equal(packet.pos, 3);
});

// A long string takes the Buffer path; a short one takes the concat path. Both
// must agree, and neither may reinterpret the high bytes.
test('gjstr decodes 0x80-0xff as latin1, not windows-1252', () => {
    for (const size of [4, 40]) {
        const bytes = new Uint8Array(size + 1);
        bytes.fill(0x80);
        bytes[1] = 0x9f;
        bytes[2] = 0xa0;
        bytes[3] = 0xff;
        bytes[size] = 10;

        const decoded = new Packet(bytes).gjstr();
        assert.equal(decoded.length, size);
        assert.equal(decoded.charCodeAt(0), 0x80, 'windows-1252 would give U+20AC here');
        assert.equal(decoded.charCodeAt(1), 0x9f);
        assert.equal(decoded.charCodeAt(3), 0xff);
    }
});

test('gjstr round-trips every byte pjstr can write', () => {
    const chars: string[] = [];
    for (let b = 1; b < 256; b++) {
        if (b !== 10) {
            chars.push(String.fromCharCode(b));
        }
    }
    const original = chars.join('');

    const packet = Packet.alloc(1); // 5000 bytes; alloc(0) is only 100
    packet.pjstr(original);
    packet.pos = 0;
    assert.equal(packet.gjstr(), original);
});

test('gjstr throws when the cursor is already past the end', () => {
    const packet = new Packet(Uint8Array.from([65, 10]));
    packet.pos = 2;
    assert.throws(() => packet.gjstr(), RangeError);
});

test('gjstr matches the per-character implementation it replaced', () => {
    let checked = 0;

    for (let iteration = 0; iteration < 200_000; iteration++) {
        const size = (1 + Math.random() * 40) | 0;
        const offset = (Math.random() * 7) | 0;
        const terminator = Math.random() < 0.5 ? 10 : 0;

        const buffer = new ArrayBuffer(offset + size);
        const bytes = new Uint8Array(buffer, offset, size);
        for (let i = 0; i < size; i++) {
            // bias towards the terminator so both branches get exercised
            bytes[i] = Math.random() < 0.15 ? terminator : (Math.random() * 256) | 0;
        }

        const start = (Math.random() * (size + 1)) | 0;

        const actual = new Packet(bytes);
        actual.pos = start;

        let legacyValue: string | null = null;
        let legacyPos: number = -1;
        let legacyError: string | null = null;
        try {
            const result = legacyGjstr(bytes, start, terminator);
            legacyValue = result.value;
            legacyPos = result.pos;
        } catch (err) {
            legacyError = (err as Error).constructor.name;
        }

        let actualValue: string | null = null;
        let actualError: string | null = null;
        try {
            actualValue = actual.gjstr(terminator);
        } catch (err) {
            actualError = (err as Error).constructor.name;
        }

        const context = `size=${size} offset=${offset} start=${start} term=${terminator} bytes=[${bytes}]`;
        assert.equal(actualError, legacyError, `thrown error differs: ${context}`);
        assert.equal(actualValue, legacyValue, `value differs: ${context}`);
        if (legacyError === null) {
            assert.equal(actual.pos, legacyPos, `cursor differs: ${context}`);
        }
        checked++;
    }

    assert.equal(checked, 200_000);
});
