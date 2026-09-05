import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import InputRing, { CHUNK_AGE_LIMIT, CHUNK_SIZE_LIMIT, FLOOD_BUDGET_BYTES, FLOOD_WINDOW_TICKS, InputMarker, InputRecord, MOVE_PAYLOAD_LIMIT, RING_CAPACITY } from '#/engine/entity/tracking/InputRing.js';
import type { InputChunk } from '#/engine/entity/tracking/InputRing.js';

/**
 * The input ring's framing is a cross-repo contract: the engine writes it into
 * `report_input.data` and the website's macro decoder is the only thing that
 * ever reads it back. `test/fixtures/input-tracking-contract.json` is that
 * contract - one real chunk as base64, with the event list any correct decoder
 * must produce from it - and the website copies the file verbatim.
 *
 * So this file does three things: it drives the ring the way the world does
 * and checks the rules (rotation, the ring's capacity, the flood cap, the live
 * tail), it re-implements the client's own mouse encoding well enough to make
 * a realistic chunk, and it decodes that chunk back and asserts the fixture's
 * event list is exactly what comes out. A change to either side that the other
 * does not follow fails here rather than on a moderator's screen.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/input-tracking-contract.json', import.meta.url), 'utf8')) as InputContract;

type InputContract = {
    records: Record<string, number>;
    markers: Record<string, number>;
    limits: Record<string, number>;
    client: Record<string, number>;
    chunk: {
        seq: number;
        started_at: number;
        flushed_at: number;
        client: string;
        data: string;
    };
    events: DecodedEvent[];
};

type DecodedEvent = {
    type: string;
    t: number;
    ticks?: number;
    reason?: number;
    focus?: number;
    pitch?: number;
    yaw?: number;
    delta?: number;
    button?: number;
    x?: number | null;
    y?: number | null;
};

// ---------------------------------------------------------------------------
// the client's own mouse encoding, mirrored from Client.ts:2061-2129
// ---------------------------------------------------------------------------

/**
 * The cursor state the client carries between packets: it is session-global
 * there and is not reset on reconnect, which is exactly why a chunk that opens
 * with a relative step has no idea where the cursor is. Sampled every 50ms.
 */
class ReferenceClient {
    x: number = 0;
    y: number = 0;
    delta: number = 0;

    /** One EVENT_MOUSE_MOVE payload from a run of 50ms samples. */
    packet(samples: [number, number][]): Uint8Array {
        const out: number[] = [];

        for (const [rawX, rawY] of samples) {
            let x = rawX < 0 ? 0 : rawX > 764 ? 764 : rawX;
            let y = rawY < 0 ? 0 : rawY > 502 ? 502 : rawY;
            let pos = y * 765 + x;

            if (rawX === -1 && rawY === -1) {
                x = -1;
                y = -1;
                pos = 0x7ffff;
            }

            if (x !== this.x || y !== this.y) {
                const dx = x - this.x;
                const dy = y - this.y;
                this.x = x;
                this.y = y;

                if (this.delta < 8 && dx >= -32 && dx <= 31 && dy >= -32 && dy <= 31) {
                    const word = (this.delta << 12) + ((dx + 32) << 6) + (dy + 32);
                    out.push((word >>> 8) & 0xff, word & 0xff);
                } else if (this.delta < 8) {
                    const word = 0x800000 + (this.delta << 19) + pos;
                    out.push((word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
                } else {
                    const word = (0xc0000000 + (this.delta << 19) + pos) >>> 0;
                    out.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
                }

                this.delta = 0;
            } else if (this.delta < 2047) {
                this.delta++;
            }
        }

        return Uint8Array.from(out);
    }
}

/** The client's click word: `(delta50ms << 20) | (button << 19) | (y * 765 + x)`. */
function clickWord(delta: number, button: number, x: number, y: number): number {
    return ((delta << 20) + (button << 19) + (y * 765 + x)) >>> 0;
}

// ---------------------------------------------------------------------------
// the decoder the contract is written against
// ---------------------------------------------------------------------------

/**
 * Bytes back to events, with `t` in milliseconds from the chunk's `started_at`.
 *
 * The timing rule, which is the half of the contract that is not just field
 * widths: a time anchor sets the arrival clock to `ticks * 600`, every camera,
 * focus, click and marker record takes the arrival clock in force, and a move
 * record's samples *end* at it - sample k of the N samples the record accounts
 * for sits at `T - (N - 1 - k) * 50`, because the packet was assembled from a
 * 50ms sampler and sent at the end of the run. A step encodes `delta` samples
 * where the cursor did not move followed by the one where it did, so it
 * accounts for `delta + 1` of them.
 */
function decodeChunk(bytes: Uint8Array): DecodedEvent[] {
    const events: DecodedEvent[] = [];

    let t = 0;
    let x: number | null = null;
    let y: number | null = null;
    let pos = 0;

    const u8 = () => bytes[pos++];
    const u16 = () => ((bytes[pos++] << 8) | bytes[pos++]) >>> 0;
    const u32 = () => (((bytes[pos++] << 24) | (bytes[pos++] << 16) | (bytes[pos++] << 8) | bytes[pos++]) >>> 0) >>> 0;

    while (pos < bytes.length) {
        const type = u8();

        if (type === InputRecord.TIME_ANCHOR) {
            const ticks = u16();
            t = ticks * 600;
            events.push({ type: 'anchor', t, ticks });
        } else if (type === InputRecord.MARKER) {
            events.push({ type: 'marker', t, reason: u8() });
        } else if (type === InputRecord.APPLET_FOCUS) {
            events.push({ type: 'focus', t, focus: u8() });
        } else if (type === InputRecord.CAMERA_POSITION) {
            const pitch = u16();
            const yaw = u16();
            events.push({ type: 'camera', t, pitch, yaw });
        } else if (type === InputRecord.MOUSE_CLICK) {
            const info = u32();
            const at = info & 0x7ffff;
            const cx = at % 765;

            events.push({ type: 'click', t, delta: (info >>> 20) & 0xfff, button: (info >>> 19) & 1, x: cx, y: (at - cx) / 765 });
        } else if (type === InputRecord.MOUSE_MOVE) {
            const len = u8();
            const end = pos + len;
            const steps: { delta: number; dx?: number; dy?: number; at?: number }[] = [];

            while (pos < end) {
                const head = bytes[pos];

                if (head < 0x80) {
                    const word = u16();
                    steps.push({ delta: word >>> 12, dx: ((word >>> 6) & 0x3f) - 32, dy: (word & 0x3f) - 32 });
                } else if (head < 0xc0) {
                    const word = ((bytes[pos++] << 16) | (bytes[pos++] << 8) | bytes[pos++]) >>> 0;
                    steps.push({ delta: (word >>> 19) & 7, at: word & 0x7ffff });
                } else {
                    const word = u32();
                    steps.push({ delta: (word >>> 19) & 0x7ff, at: word & 0x7ffff });
                }
            }

            const samples = steps.reduce((total, step) => total + step.delta + 1, 0);
            let index = -1;

            for (const step of steps) {
                index += step.delta + 1;

                if (typeof step.at === 'number') {
                    if (step.at === 0x7ffff) {
                        x = -1;
                        y = -1;
                    } else {
                        x = step.at % 765;
                        y = (step.at - x) / 765;
                    }
                } else if (x !== null && y !== null) {
                    x += step.dx as number;
                    y += step.dy as number;
                }

                events.push({ type: 'move', t: t - (samples - 1 - index) * 50, delta: step.delta, x, y });
            }
        } else {
            throw new Error(`unknown record type ${type} at ${pos - 1}`);
        }
    }

    return events;
}

// ---------------------------------------------------------------------------
// the contract chunk
// ---------------------------------------------------------------------------

const START = Date.UTC(2026, 8, 5, 12, 0, 0);

/** The tick the contract chunk opens on; the seventeen before it primed the ring. */
const BASE_TICK = 1700;

/** Where the contract chunk begins: after seventeen minutes of one-record chunks. */
const CHUNK_START = START + RING_CAPACITY * CHUNK_AGE_LIMIT + CHUNK_AGE_LIMIT;

/**
 * The whole of the contract, built by driving the real ring. Seventeen tiny
 * chunks go in first so the sixteen-chunk ring has already dropped one, which
 * is what puts marker 3 at the head of the chunk the fixture pins; the rest is
 * one busy tick, two clicks, a camera nudge and the three markers a live
 * capture can carry.
 */
function buildContract(): { chunk: InputChunk; primed: InputChunk[] } {
    const rotated: InputChunk[] = [];
    const ring = new InputRing(chunk => rotated.push(chunk));

    // seventeen one-record chunks, each sealed by the 60s age limit
    for (let i = 0; i <= RING_CAPACITY; i++) {
        ring.appletFocus(i * 100, START + i * CHUNK_AGE_LIMIT, 1);
        ring.onCycle(START + (i + 1) * CHUNK_AGE_LIMIT);
    }

    const primed = ring.drainRing();

    const at = (tick: number) => CHUNK_START + tick * 600;
    const client = new ReferenceClient();

    // t=0: focus regained, then a move packet that starts relative (so the
    // cursor is unknown), goes absolute, sits still long enough to need the
    // 4-byte form, leaves the applet and comes back
    ring.appletFocus(BASE_TICK, at(0), 1);
    ring.mouseMove(
        BASE_TICK,
        at(0),
        client.packet([
            [10, 12],
            [12, 14],
            [200, 300],
            [200, 300],
            [200, 300],
            [200, 300],
            [200, 300],
            [200, 300],
            [200, 300],
            [200, 300],
            [200, 300],
            [205, 305],
            [-1, -1],
            [300, 400],
            [299, 399]
        ])
    );

    // t=3: an ordinary click
    ring.mouseClick(BASE_TICK + 3, at(3), clickWord(20, 0, 100, 50));

    // t=6: the camera, a short move run, and a right-click with the delta
    // saturated - the click word's top bit is set, which is the case a signed
    // read gets wrong
    ring.cameraPosition(BASE_TICK + 6, at(6), 128, 1024);
    ring.mouseMove(
        BASE_TICK + 6,
        at(6),
        client.packet([
            [299, 399],
            [299, 399],
            [299, 399],
            [310, 410],
            [311, 411]
        ])
    );
    ring.mouseClick(BASE_TICK + 6, at(6), clickWord(4095, 1, 764, 502));

    // t=9: a move packet too long for the length field
    ring.mouseMove(BASE_TICK + 9, at(9), new Uint8Array(MOVE_PAYLOAD_LIMIT + 45));

    // t=10 and t=12: the two markers a synthetic chunk cannot reach honestly -
    // the flood cap needs 8 KB of input and the live tail needs a report - so
    // they are written directly. A decoder has to handle a marker anywhere.
    ring.mark(BASE_TICK + 10, at(10), InputMarker.FLOOD_CAP);
    ring.mark(BASE_TICK + 12, at(12), InputMarker.LIVE_TAIL_BEGINS);
    ring.appletFocus(BASE_TICK + 12, at(12), 0);

    // sealed by age, like any quiet chunk
    ring.onCycle(at(0) + CHUNK_AGE_LIMIT);

    const chunks = ring.drainRing();
    assert.equal(chunks.length, 1, 'the contract is one chunk');

    return { chunk: chunks[0], primed };
}

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

/** Drive a ring and take the one chunk it produces. */
function oneChunk(drive: (ring: InputRing) => void): InputChunk {
    const ring = new InputRing(() => assert.fail('nothing should be live here'));

    drive(ring);
    ring.onCycle(START + CHUNK_AGE_LIMIT);

    const chunks = ring.drainRing();
    assert.equal(chunks.length, 1);
    return chunks[0];
}

test('each record type writes the bytes the contract names', () => {
    const chunk = oneChunk(ring => {
        ring.cameraPosition(0, START, 128, 1024);
        ring.appletFocus(0, START, 1);
        ring.mouseClick(0, START, 0xdeadbeef);
        ring.mouseMove(0, START, Uint8Array.from([1, 2, 3]));
        ring.mark(0, START, InputMarker.RING_WRAPPED);
    });

    assert.deepEqual(
        [...chunk.bytes],
        [
            InputRecord.TIME_ANCHOR,
            0,
            0, // anchor, tick 0
            InputRecord.CAMERA_POSITION,
            0,
            128,
            4,
            0, // pitch 128, yaw 1024
            InputRecord.APPLET_FOCUS,
            1,
            InputRecord.MOUSE_CLICK,
            0xde,
            0xad,
            0xbe,
            0xef,
            InputRecord.MOUSE_MOVE,
            3,
            1,
            2,
            3,
            InputRecord.MARKER,
            InputMarker.RING_WRAPPED
        ]
    );
});

test('the click word survives the top bit being set', () => {
    const info = clickWord(4095, 1, 764, 502);
    const chunk = oneChunk(ring => ring.mouseClick(0, START, info));
    const [, click] = decodeChunk(chunk.bytes);

    assert.ok(info > 0x7fffffff, 'the fixture case is meant to be an unsigned word');
    assert.deepEqual(click, { type: 'click', t: 0, delta: 4095, button: 1, x: 764, y: 502 });
});

test('a time anchor is written once per tick, ahead of that tick first record', () => {
    const chunk = oneChunk(ring => {
        ring.appletFocus(10, START, 1);
        ring.appletFocus(10, START, 0);
        ring.appletFocus(13, START + 1800, 1);
    });

    // ticks are counted from the chunk's own first record, not from the world
    assert.deepEqual([...chunk.bytes], [InputRecord.TIME_ANCHOR, 0, 0, InputRecord.APPLET_FOCUS, 1, InputRecord.APPLET_FOCUS, 0, InputRecord.TIME_ANCHOR, 0, 3, InputRecord.APPLET_FOCUS, 1]);
});

test('a chunk begins when its first record does, not when the ring was made', () => {
    const ring = new InputRing(() => assert.fail('nothing is live'));

    ring.onCycle(START);
    ring.appletFocus(0, START + 5000, 1);
    ring.onCycle(START + 5000 + CHUNK_AGE_LIMIT);

    const [chunk] = ring.drainRing();
    assert.equal(chunk.startedAt, START + 5000);
    assert.equal(chunk.flushedAt, START + 5000 + CHUNK_AGE_LIMIT);
    assert.equal(chunk.seq, 0);
});

// ---------------------------------------------------------------------------
// rotation
// ---------------------------------------------------------------------------

test('a chunk rotates before it can pass the size limit', () => {
    const ring = new InputRing(() => assert.fail('nothing is live'));

    // 253 bytes of payload per record, so nothing lines up neatly with 1500
    for (let i = 0; i < 20; i++) {
        ring.mouseMove(i, START + i * 600, new Uint8Array(253));
    }

    ring.onCycle(START + 20 * 600 + CHUNK_AGE_LIMIT);

    const chunks = ring.drainRing();
    assert.ok(chunks.length > 1, 'twenty move records do not fit in one chunk');

    for (const chunk of chunks) {
        assert.ok(chunk.bytes.length <= CHUNK_SIZE_LIMIT, `chunk ${chunk.seq} is ${chunk.bytes.length} bytes`);
    }

    // and the sequence numbers are dense and ordered
    assert.deepEqual(
        chunks.map(chunk => chunk.seq),
        chunks.map((_, i) => i)
    );
});

test('a quiet chunk rotates on age, and an empty one does not rotate at all', () => {
    const ring = new InputRing(() => assert.fail('nothing is live'));

    ring.onCycle(START + CHUNK_AGE_LIMIT * 10);
    assert.equal(ring.size, 0, 'an empty ring has nothing to seal');

    ring.appletFocus(0, START, 1);
    ring.onCycle(START + CHUNK_AGE_LIMIT - 1);
    assert.equal(ring.size, 0, 'one millisecond short');

    ring.onCycle(START + CHUNK_AGE_LIMIT);
    assert.equal(ring.size, 1);
    assert.equal(ring.drainRing()[0].flushedAt, START + CHUNK_AGE_LIMIT);
});

test('the ring keeps sixteen chunks and says so when it drops one', () => {
    const ring = new InputRing(() => assert.fail('nothing is live'));

    const seal = (i: number) => {
        ring.appletFocus(i * 100, START + i * CHUNK_AGE_LIMIT, 1);
        ring.onCycle(START + (i + 1) * CHUNK_AGE_LIMIT);
        assert.ok(ring.size <= RING_CAPACITY);
    };

    // seventeen chunks written, sixteen kept
    for (let i = 0; i <= RING_CAPACITY; i++) {
        seal(i);
    }

    const chunks = ring.drainRing();
    assert.equal(chunks.length, RING_CAPACITY);
    assert.deepEqual(
        chunks.map(chunk => chunk.seq),
        chunks.map((_, i) => i + 1)
    );

    // none of them carries the marker: the drop happened as the last of them
    // was filed, so the hole is in front of whatever comes next
    for (const chunk of chunks) {
        assert.equal(chunk.bytes[0], InputRecord.TIME_ANCHOR, `chunk ${chunk.seq}`);
    }

    seal(RING_CAPACITY + 1);
    const [next] = ring.drainRing();
    assert.deepEqual([...next.bytes.slice(0, 2)], [InputRecord.MARKER, InputMarker.RING_WRAPPED]);
});

// ---------------------------------------------------------------------------
// the caps
// ---------------------------------------------------------------------------

test('a move packet the length field cannot describe is dropped, with a marker', () => {
    const chunk = oneChunk(ring => {
        ring.mouseMove(0, START, new Uint8Array(MOVE_PAYLOAD_LIMIT));
        ring.mouseMove(0, START, new Uint8Array(MOVE_PAYLOAD_LIMIT + 1));
        ring.mouseMove(0, START, new Uint8Array(0));
    });

    // the 255-byte one is framed, the 256-byte one leaves a marker, the empty
    // one leaves nothing at all
    assert.equal(chunk.bytes.length, 3 + (2 + MOVE_PAYLOAD_LIMIT) + 2);
    assert.deepEqual([...chunk.bytes.slice(-2)], [InputRecord.MARKER, InputMarker.MOVE_PACKET_DROPPED]);
});

test('the flood cap trips once, drops the rest of the window, and lets the next one through', () => {
    const ring = new InputRing(() => assert.fail('nothing is live'));

    // 200 x 250 payload bytes is 50 KB of client input inside one window
    for (let i = 0; i < 200; i++) {
        ring.mouseMove(1, START, new Uint8Array(250));
    }

    ring.onCycle(START + CHUNK_AGE_LIMIT);
    const flooded = ring.drainRing();
    const bytes = flooded.reduce((total, chunk) => total + chunk.bytes.length, 0);

    assert.ok(bytes < FLOOD_BUDGET_BYTES + CHUNK_SIZE_LIMIT, `${bytes} bytes got through an ${FLOOD_BUDGET_BYTES} byte budget`);

    const markers = flooded.flatMap(chunk => decodeChunk(chunk.bytes)).filter(event => event.type === 'marker' && event.reason === InputMarker.FLOOD_CAP);
    assert.equal(markers.length, 1, 'the cap says so once, not once per dropped packet');

    // the window rolls over and the player is heard again
    ring.mouseMove(1 + FLOOD_WINDOW_TICKS, START + FLOOD_WINDOW_TICKS * 600, new Uint8Array(10));
    ring.onCycle(START + FLOOD_WINDOW_TICKS * 600 + CHUNK_AGE_LIMIT);

    const after = ring.drainRing();
    assert.equal(after.length, 1);
    assert.deepEqual([...after[0].bytes.slice(3, 5)], [InputRecord.MOUSE_MOVE, 10]);
});

// ---------------------------------------------------------------------------
// the live tail
// ---------------------------------------------------------------------------

test('track seals the ring at the report instant and opens the tail with marker 4', () => {
    const live: InputChunk[] = [];
    const ring = new InputRing(chunk => live.push(chunk));

    ring.appletFocus(0, START, 1);
    ring.appletFocus(1, START + 600, 0);

    assert.equal(ring.isTracked(START + 1200), false);
    ring.track(START + 900_000, 2, START + 1200);
    assert.equal(ring.isTracked(START + 1200), true);
    assert.equal(ring.activeUntil, START + 900_000);

    // what was in flight became a ring chunk, sealed at the report
    const before = ring.drainRing();
    assert.equal(before.length, 1);
    assert.equal(before[0].flushedAt, START + 1200);
    assert.equal(live.length, 0, 'the pre-report chunk is not live evidence');

    // and the tail opens with its marker
    ring.mouseClick(3, START + 1800, clickWord(1, 0, 5, 5));
    ring.onCycle(START + 1800 + CHUNK_AGE_LIMIT);

    assert.equal(live.length, 1);
    assert.equal(ring.size, 0, 'a tracked chunk is submitted, not remembered');
    assert.deepEqual([...live[0].bytes.slice(0, 5)], [InputRecord.TIME_ANCHOR, 0, 0, InputRecord.MARKER, InputMarker.LIVE_TAIL_BEGINS]);
});

test('the tail expires on its own, and the last of it is still submitted', () => {
    const live: InputChunk[] = [];
    const ring = new InputRing(chunk => live.push(chunk));

    ring.track(START + 10_000, 0, START);
    ring.appletFocus(1, START + 600, 1);

    ring.onCycle(START + 9_999);
    assert.equal(live.length, 0, 'still running');

    ring.onCycle(START + 10_000);
    assert.equal(live.length, 1, 'the part chunk is submitted as live, not dropped into the ring');
    assert.equal(ring.activeUntil, 0);
    assert.equal(ring.isTracked(START + 10_000), false);

    // and the ring takes over again
    ring.appletFocus(20, START + 12_000, 0);
    ring.onCycle(START + 12_000 + CHUNK_AGE_LIMIT);
    assert.equal(live.length, 1);
    assert.equal(ring.size, 1);
});

test('flush seals the chunk in flight without opening a tail', () => {
    const ring = new InputRing(() => assert.fail('nothing is live'));

    ring.appletFocus(0, START, 1);
    ring.flush(START + 1200);

    // the ring-only dump a world already running five tails gives a report:
    // everything up to the report instant, and no marker 4 to promise more
    const chunks = ring.drainRing();
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].flushedAt, START + 1200);
    assert.equal(ring.activeUntil, 0);
    assert.deepEqual([...chunks[0].bytes], [InputRecord.TIME_ANCHOR, 0, 0, InputRecord.APPLET_FOCUS, 1]);

    // and flushing an empty chunk files nothing
    ring.flush(START + 1800);
    assert.equal(ring.size, 0);
});

test('untrack submits what the tail had, and clear throws everything away', () => {
    const live: InputChunk[] = [];
    const ring = new InputRing(chunk => live.push(chunk));

    ring.track(START + 900_000, 0, START);
    ring.appletFocus(1, START + 600, 1);
    ring.untrack(START + 1200);

    assert.equal(live.length, 1);
    assert.equal(live[0].flushedAt, START + 1200);
    assert.equal(ring.activeUntil, 0);

    ring.appletFocus(3, START + 1800, 0);
    ring.onCycle(START + 1800 + CHUNK_AGE_LIMIT);
    assert.equal(ring.size, 1);

    ring.clear();
    assert.equal(ring.size, 0);
    assert.equal(ring.pending, 0);
});

// ---------------------------------------------------------------------------
// the contract
// ---------------------------------------------------------------------------

test('the contract fixture is the chunk this ring writes', () => {
    const { chunk, primed } = buildContract();

    assert.equal(primed.length, RING_CAPACITY, 'the ring dropped the seventeenth chunk before the contract one');
    assert.equal(chunk.seq, fixture.chunk.seq);
    assert.equal(chunk.startedAt, fixture.chunk.started_at);
    assert.equal(chunk.flushedAt, fixture.chunk.flushed_at);
    assert.equal(Buffer.from(chunk.bytes).toString('base64'), fixture.chunk.data);
});

test('the contract fixture decodes to the event list it publishes', () => {
    const { chunk } = buildContract();

    assert.deepEqual(decodeChunk(chunk.bytes), fixture.events);
    assert.deepEqual(decodeChunk(new Uint8Array(Buffer.from(fixture.chunk.data, 'base64'))), fixture.events);
});

test('the contract fixture publishes the record types, markers and limits the engine uses', () => {
    assert.deepEqual(fixture.records, {
        camera_position: InputRecord.CAMERA_POSITION,
        applet_focus: InputRecord.APPLET_FOCUS,
        mouse_click: InputRecord.MOUSE_CLICK,
        mouse_move: InputRecord.MOUSE_MOVE,
        time_anchor: InputRecord.TIME_ANCHOR,
        marker: InputRecord.MARKER
    });

    assert.deepEqual(fixture.markers, {
        move_packet_dropped: InputMarker.MOVE_PACKET_DROPPED,
        flood_cap: InputMarker.FLOOD_CAP,
        ring_wrapped: InputMarker.RING_WRAPPED,
        live_tail_begins: InputMarker.LIVE_TAIL_BEGINS
    });

    assert.deepEqual(fixture.limits, {
        chunk_size_bytes: CHUNK_SIZE_LIMIT,
        chunk_age_ms: CHUNK_AGE_LIMIT,
        ring_capacity: RING_CAPACITY,
        move_payload_bytes: MOVE_PAYLOAD_LIMIT,
        flood_window_ticks: FLOOD_WINDOW_TICKS,
        flood_budget_bytes: FLOOD_BUDGET_BYTES
    });

    // the client's own constants, which the decoder needs and the engine never
    // writes down anywhere else
    assert.deepEqual(fixture.client, {
        tick_ms: 600,
        sample_ms: 50,
        screen_width: 765,
        screen_height: 503,
        offscreen_pos: 0x7ffff,
        click_delta_max: 4095,
        move_delta_max: 2047
    });
});

test('every event in the contract carries a type the decoder produces', () => {
    const kinds = new Set(fixture.events.map(event => event.type));

    assert.deepEqual([...kinds].sort(), ['anchor', 'camera', 'click', 'focus', 'marker', 'move']);

    // and all four marker reasons
    const reasons = new Set(fixture.events.filter(event => event.type === 'marker').map(event => event.reason));
    assert.deepEqual([...reasons].sort(), [InputMarker.MOVE_PACKET_DROPPED, InputMarker.FLOOD_CAP, InputMarker.RING_WRAPPED, InputMarker.LIVE_TAIL_BEGINS]);
});

test('the contract exercises every move encoding, including an unknown cursor', () => {
    const moves = fixture.events.filter(event => event.type === 'move');

    assert.ok(
        moves.some(move => move.x === null),
        'a chunk that opens on a relative step does not know where the cursor is'
    );
    assert.ok(
        moves.some(move => move.x === -1 && move.y === -1),
        'the cursor leaving the applet is pos 0x7ffff'
    );
    assert.ok(
        moves.some(move => (move.delta as number) >= 8),
        'a gap of eight samples or more needs the 4-byte form'
    );
    assert.ok(
        moves.some(move => (move.delta as number) > 0 && (move.delta as number) < 8),
        'a short gap rides in the 2-byte form'
    );
});
