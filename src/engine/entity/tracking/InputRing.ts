/**
 * The per-player input ring: what the world remembers about a player's mouse
 * and keyboard focus *before* anybody reports them.
 *
 * Input tracking used to be switched on by the report itself, which meant the
 * record started after the moment that mattered - a moderator opening a macro
 * report saw the minutes the offender spent being watched, never the minutes
 * that got them reported. Recording is always on now, into this ring, and a
 * report drains it.
 *
 * ## The framing
 *
 * A chunk is a sequence of records, each a one-byte type followed by a fixed
 * or self-describing payload, big-endian throughout (the same `p1`/`p2`/`p4`
 * the rest of the engine writes):
 *
 * | Type | Record | Payload |
 * | --- | --- | --- |
 * | 1 | camera position | `p2` pitch, `p2` yaw |
 * | 2 | applet focus | `p1` focus (1 gained, 0 lost) |
 * | 3 | mouse click | `p4` the client's click word |
 * | 4 | mouse move | `p1` length, then that many bytes of the client's own move encoding |
 * | 5 | time anchor | `p2` ticks since the chunk began |
 * | 6 | marker | `p1` reason |
 *
 * Records 1-4 are the client's, passed through untouched: the click word is
 * `(delta50ms << 20) | (button << 19) | (y * 765 + x)` and the move bytes are
 * the 2/3/4-byte cursor encoding, both decoded by the website and by nothing
 * else. Records 5 and 6 are the engine's, and exist because the client sends
 * no timestamps at all: without them a chunk is an ordered list of events with
 * no way back to wall-clock time, and no way to tell "the player stopped
 * moving the mouse" from "the world stopped listening".
 *
 * A time anchor is written at most once per tick, ahead of the first record
 * that tick appends, so every record's arrival time is known to 600ms from the
 * chunk's `startedAt`. A marker says why the record is not complete:
 *
 * | Reason | Meaning |
 * | --- | --- |
 * | 1 | a move packet was dropped (too long to frame) |
 * | 2 | the flood cap tripped: input is being discarded until the window passes |
 * | 3 | the ring wrapped: chunks older than this one were dropped |
 * | 4 | the live tail begins here - everything after it is after the report |
 *
 * ## The budget
 *
 * A chunk rotates at 1500 bytes or 60 seconds, whichever comes first, and 16
 * finished chunks are kept - about ten minutes of ordinary play and at most
 * 24 KB per player. Beyond that the oldest is dropped and the next chunk to
 * begin says so with marker 3.
 *
 * A client that streams faster than a person can move a mouse is capped at
 * 8 KB per 100 ticks; the overflow writes marker 2 once and everything is
 * discarded until the window rolls over. Without it a modified client could
 * spend the world's memory 24 KB at a time, one throwaway account each.
 *
 * Nothing here imports `World`: the ring is fed ticks and timestamps by its
 * caller, which is what lets `test/InputRing.test.ts` drive a whole session
 * deterministically and pin the framing in a fixture the website reads.
 */

/** The record types. `data` in `report_input` is a sequence of these. */
export const enum InputRecord {
    CAMERA_POSITION = 1,
    APPLET_FOCUS = 2,
    MOUSE_CLICK = 3,
    MOUSE_MOVE = 4,
    TIME_ANCHOR = 5,
    MARKER = 6
}

/** Why a marker record is there. */
export const enum InputMarker {
    MOVE_PACKET_DROPPED = 1,
    FLOOD_CAP = 2,
    RING_WRAPPED = 3,
    LIVE_TAIL_BEGINS = 4
}

/**
 * One finished chunk. `seq` counts from 0 for the life of the player object
 * and orders the chunks of one report; `startedAt` is when its first record
 * was appended and `flushedAt` when it was sealed, which is the pair the
 * website's decoder reconstructs times between.
 */
export type InputChunk = {
    seq: number;
    startedAt: number;
    flushedAt: number;
    bytes: Uint8Array;
};

/** Rotate once a chunk reaches this many bytes. */
export const CHUNK_SIZE_LIMIT = 1500;

/** ...or this old, so a quiet player's chunk still reaches the database. */
export const CHUNK_AGE_LIMIT = 60_000;

/** Finished chunks kept per player. 16 x 1500 bytes is the 24 KB worst case. */
export const RING_CAPACITY = 16;

/** The move record's length is a `p1`, so this is the longest payload it can frame. */
export const MOVE_PAYLOAD_LIMIT = 255;

/** The flood window, in ticks. */
export const FLOOD_WINDOW_TICKS = 100;

/** What a player may spend in one flood window before marker 2 and the drop. */
export const FLOOD_BUDGET_BYTES = 8 * 1024;

/** A move record is the biggest thing that can be written: type, length, payload. */
const MAX_RECORD_BYTES = 2 + MOVE_PAYLOAD_LIMIT;

/** The anchor that may be written ahead of it. */
const ANCHOR_BYTES = 3;

/**
 * A record is only appended when it fits under the soft limit, so a chunk
 * never exceeds it - but the buffer carries the slack anyway, because the one
 * case that can write past the limit is a marker forced into a chunk that is
 * already full, and a bounds check that can fail is worse than 258 bytes.
 */
const CHUNK_CAPACITY = CHUNK_SIZE_LIMIT + MAX_RECORD_BYTES + ANCHOR_BYTES;

export default class InputRing {
    /** Called with each chunk sealed while the live tail is running. */
    private readonly onRotate: (chunk: InputChunk) => void;

    private readonly buf: Uint8Array = new Uint8Array(CHUNK_CAPACITY);
    private readonly view: DataView = new DataView(this.buf.buffer);
    private pos: number = 0;

    private seq: number = 0;
    private startedAt: number = 0;
    private startTick: number = 0;
    private anchoredTick: number = -1;

    private chunks: InputChunk[] = [];
    private wrapped: boolean = false;

    private floodWindow: number = -1;
    private floodBytes: number = 0;
    private flooded: boolean = false;

    private until: number = 0;

    constructor(onRotate: (chunk: InputChunk) => void) {
        this.onRotate = onRotate;
    }

    /** When the live tail ends, as an epoch ms; 0 when nothing is tracked. */
    get activeUntil(): number {
        return this.until;
    }

    /** How many finished chunks are held. Only the tests and the report path care. */
    get size(): number {
        return this.chunks.length;
    }

    /** Bytes in the chunk currently being written. */
    get pending(): number {
        return this.pos;
    }

    isTracked(now: number): boolean {
        return this.until > 0 && now < this.until;
    }

    /**
     * Start (or extend) a live tail. Whatever is in flight is sealed first, so
     * the ring dump ends at the report instant rather than straddling it, and
     * the tail then opens with marker 4 - the record that tells the website
     * where "before" stops and "after" starts.
     *
     * Sealing before `until` is set is deliberate: an untracked player's part
     * chunk belongs to the ring, and an already-tracked one's belongs to the
     * tail, and `rotate()` routes on exactly that.
     */
    track(untilMs: number, tick: number, now: number): void {
        this.rotate(now);
        this.until = untilMs;
        this.mark(tick, now, InputMarker.LIVE_TAIL_BEGINS);
    }

    /**
     * End the tail now. The part chunk is sealed while the tail is still
     * running, so the last seconds of it are submitted rather than falling
     * into the ring to be dropped later.
     */
    untrack(now: number): void {
        if (this.until === 0) {
            return;
        }

        // sealed as live on `until`, not on `isTracked(now)`: a tail whose time
        // ran out a moment ago but which `onCycle` has not swept yet still
        // captured every byte in that chunk after the report, and routing it
        // into the ring would throw the last seconds of the evidence away.
        if (this.pos > 0) {
            this.seal(now, true);
        }

        this.until = 0;
    }

    /**
     * Push the tail's end back. A second report on somebody already being
     * watched extends the window it already has rather than opening another
     * one, and unlike `track()` this leaves the chunk in flight alone - there
     * is no new "the live tail begins here" to mark, because it did not.
     */
    extend(untilMs: number): void {
        if (this.until > 0 && untilMs > this.until) {
            this.until = untilMs;
        }
    }

    /**
     * Once per game cycle: expire the tail, and rotate the chunk in flight if
     * it is full or old. Nothing else moves time forward, so a player who has
     * gone quiet still gets their chunk sealed within a minute.
     */
    onCycle(now: number): void {
        if (this.until > 0 && now >= this.until) {
            this.untrack(now);
        }

        if (this.pos > 0 && (this.pos >= CHUNK_SIZE_LIMIT || now - this.startedAt >= CHUNK_AGE_LIMIT)) {
            this.rotate(now);
        }
    }

    /**
     * Seal whatever is in flight without touching the tail. A report that only
     * gets the ring dump still wants the seconds since the last rotation.
     */
    flush(now: number): void {
        this.rotate(now);
    }

    /** The finished chunks, oldest first; the ring is left empty. */
    drainRing(): InputChunk[] {
        const chunks = this.chunks;
        this.chunks = [];

        // whatever was dropped is dropped from a dump that has now been handed
        // over; the next chunk to begin is the first of something new, and
        // marking it "chunks older than this were discarded" would be a claim
        // about a record nobody is going to read next to it
        this.wrapped = false;

        return chunks;
    }

    /** Throw away everything held. Logout, after whatever was worth keeping was submitted. */
    clear(): void {
        this.chunks = [];
        this.pos = 0;
        this.anchoredTick = -1;
        this.wrapped = false;
        this.until = 0;
    }

    cameraPosition(tick: number, now: number, pitch: number, yaw: number): void {
        if (!this.admit(tick, now, 5)) {
            return;
        }

        this.prepare(tick, now, 5);
        this.p1(InputRecord.CAMERA_POSITION);
        this.p2(pitch);
        this.p2(yaw);
    }

    appletFocus(tick: number, now: number, focus: number): void {
        if (!this.admit(tick, now, 2)) {
            return;
        }

        this.prepare(tick, now, 2);
        this.p1(InputRecord.APPLET_FOCUS);
        this.p1(focus);
    }

    mouseClick(tick: number, now: number, info: number): void {
        if (!this.admit(tick, now, 5)) {
            return;
        }

        this.prepare(tick, now, 5);
        this.p1(InputRecord.MOUSE_CLICK);
        this.p4(info);
    }

    /**
     * A move packet, as the client framed it. An empty one carries nothing and
     * is not worth a record; one longer than the length field can describe is
     * dropped with marker 1, so the gap it leaves is visible to the decoder
     * rather than looking like a player who stopped moving.
     */
    mouseMove(tick: number, now: number, data: Uint8Array): void {
        if (data.length === 0) {
            return;
        }

        // defensive: EVENT_MOUSE_MOVE is a var-byte prot, so the wire itself
        // cannot deliver more than 255 bytes and this cannot fire today. It
        // stays because the record's length field is what makes 255 the limit,
        // and a prot widened to var-short later would silently truncate here
        // instead of leaving a marker where the gap is.
        if (data.length > MOVE_PAYLOAD_LIMIT) {
            this.mark(tick, now, InputMarker.MOVE_PACKET_DROPPED);
            return;
        }

        const len = 2 + data.length;

        if (!this.admit(tick, now, len)) {
            return;
        }

        this.prepare(tick, now, len);
        this.p1(InputRecord.MOUSE_MOVE);
        this.p1(data.length);
        this.buf.set(data, this.pos);
        this.pos += data.length;
    }

    /** Write a marker. Markers are never charged to the flood budget: they explain it. */
    mark(tick: number, now: number, reason: InputMarker): void {
        this.prepare(tick, now, 2);
        this.p1(InputRecord.MARKER);
        this.p1(reason);
    }

    private rotate(now: number): void {
        if (this.pos === 0) {
            return;
        }

        this.seal(now, this.isTracked(now));
    }

    private seal(now: number, live: boolean): void {
        const chunk: InputChunk = {
            seq: this.seq++,
            startedAt: this.startedAt,
            flushedAt: now,
            bytes: this.buf.slice(0, this.pos)
        };

        this.pos = 0;
        this.anchoredTick = -1;

        if (live) {
            this.onRotate(chunk);
        } else {
            this.push(chunk);
        }
    }

    private push(chunk: InputChunk): void {
        this.chunks.push(chunk);

        while (this.chunks.length > RING_CAPACITY) {
            this.chunks.shift();
            this.wrapped = true;
        }
    }

    /**
     * The flood cap. Only what the client sent is charged to it - anchors and
     * markers are the engine's own words about the stream, and a stream being
     * discarded still deserves the one marker that says so.
     */
    private admit(tick: number, now: number, len: number): boolean {
        if (this.floodWindow < 0 || tick < this.floodWindow || tick - this.floodWindow >= FLOOD_WINDOW_TICKS) {
            this.floodWindow = tick;
            this.floodBytes = 0;
            this.flooded = false;
        }

        if (this.flooded) {
            return false;
        }

        this.floodBytes += len;

        if (this.floodBytes > FLOOD_BUDGET_BYTES) {
            this.flooded = true;
            this.mark(tick, now, InputMarker.FLOOD_CAP);
            return false;
        }

        return true;
    }

    /**
     * Make room for a record of `len` bytes and put the chunk's own bookkeeping
     * in front of it: rotate if it would not fit under the soft limit, open a
     * new chunk (with marker 3 first if the ring dropped anything since the
     * last one), and write this tick's time anchor if it has not been written.
     */
    private prepare(tick: number, now: number, len: number): void {
        const anchor = tick === this.anchoredTick ? 0 : ANCHOR_BYTES;

        if (this.pos > 0 && this.pos + anchor + len > CHUNK_SIZE_LIMIT) {
            this.rotate(now);
        }

        if (this.pos === 0) {
            this.startedAt = now;
            this.startTick = tick;
            this.anchoredTick = -1;

            if (this.wrapped) {
                this.wrapped = false;
                this.p1(InputRecord.MARKER);
                this.p1(InputMarker.RING_WRAPPED);
            }
        }

        if (tick !== this.anchoredTick) {
            this.anchoredTick = tick;

            const ticks = tick - this.startTick;

            this.p1(InputRecord.TIME_ANCHOR);
            this.p2(ticks < 0 ? 0 : ticks > 65535 ? 65535 : ticks);
        }
    }

    private p1(value: number): void {
        this.view.setUint8(this.pos++, value & 0xff);
    }

    private p2(value: number): void {
        this.view.setUint16(this.pos, value & 0xffff);
        this.pos += 2;
    }

    private p4(value: number): void {
        this.view.setUint32(this.pos, value >>> 0);
        this.pos += 4;
    }
}
