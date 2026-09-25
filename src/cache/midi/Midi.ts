import OnDemand from '#/engine/OnDemand.js';
import { printWarning } from '#/util/Logger.js';

type MidiTempoEvent = {
    tick: number;
    tempo: number;
    order: number;
};

// todo: move reads to Packet (need ig4 and gMidiVarLen)
function readU16BE(data: Uint8Array, offset: number): number {
    return (data[offset] << 8) | data[offset + 1];
}

function readU32BE(data: Uint8Array, offset: number): number {
    return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function readU32LE(data: Uint8Array, offset: number): number {
    return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function readChunkId(data: Uint8Array, offset: number): string {
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function readVarLen(data: Uint8Array, offset: number, limit: number): { value: number; offset: number } | null {
    let value = 0;
    for (let i = 0; i < 4; i++) {
        if (offset >= limit) {
            return null;
        }

        const byte = data[offset++];
        value = (value << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) {
            return { value, offset };
        }
    }

    return null;
}

function parseMidiLength(src: Uint8Array): number | null {
    const data = unwrapRiffMidi(src);
    if (!data) {
        return null;
    }

    if (data.length < 14) {
        return null;
    }

    let offset = 0;
    if (readChunkId(data, offset) !== 'MThd') {
        return null;
    }

    const headerLength = readU32BE(data, offset + 4);
    offset += 8;
    if (headerLength < 6 || offset + headerLength > data.length) {
        return null;
    }

    const format = readU16BE(data, offset);
    const trackCount = readU16BE(data, offset + 2);
    const division = readU16BE(data, offset + 4);
    offset += headerLength;

    if (format > 2 || trackCount <= 0) {
        return null;
    }

    let maxTick = 0;
    const tempos: MidiTempoEvent[] = [];
    let tempoOrder = 0;

    for (let track = 0; track < trackCount; track++) {
        if (offset + 8 > data.length) {
            return null;
        }

        if (readChunkId(data, offset) !== 'MTrk') {
            return null;
        }

        const trackLength = readU32BE(data, offset + 4);
        offset += 8;
        const trackEnd = offset + trackLength;
        if (trackEnd > data.length) {
            return null;
        }

        let tick = 0;
        let runningStatus = 0;

        while (offset < trackEnd) {
            const delta = readVarLen(data, offset, trackEnd);
            if (!delta) {
                return null;
            }

            tick += delta.value;
            offset = delta.offset;

            if (offset >= trackEnd) {
                break;
            }

            let status = data[offset];
            if (status < 0x80) {
                if (runningStatus === 0) {
                    return null;
                }

                status = runningStatus;
            } else {
                offset++;
                if (status < 0xf0) {
                    runningStatus = status;
                }
            }

            if (status === 0xff) {
                if (offset >= trackEnd) {
                    return null;
                }

                const metaType = data[offset++];
                const lengthInfo = readVarLen(data, offset, trackEnd);
                if (!lengthInfo) {
                    return null;
                }

                const metaLength = lengthInfo.value;
                offset = lengthInfo.offset;

                if (offset + metaLength > trackEnd) {
                    return null;
                }

                if (metaType === 0x51 && metaLength === 3) {
                    const tempo = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
                    tempos.push({ tick, tempo, order: tempoOrder++ });
                }

                offset += metaLength;

                if (metaType === 0x2f) {
                    offset = trackEnd;
                    break;
                }
            } else if (status === 0xf0 || status === 0xf7) {
                const lengthInfo = readVarLen(data, offset, trackEnd);
                if (!lengthInfo) {
                    return null;
                }

                const sysexLength = lengthInfo.value;
                offset = lengthInfo.offset + sysexLength;
                if (offset > trackEnd) {
                    return null;
                }
            } else if (status >= 0xf0) {
                let dataBytes = 0;
                if (status === 0xf1 || status === 0xf3) {
                    dataBytes = 1;
                } else if (status === 0xf2) {
                    dataBytes = 2;
                }

                offset += dataBytes;
                if (offset > trackEnd) {
                    return null;
                }
            } else {
                const type = status & 0xf0;
                const dataBytes = type === 0xc0 || type === 0xd0 ? 1 : 2;
                offset += dataBytes;
                if (offset > trackEnd) {
                    return null;
                }
            }
        }

        if (tick > maxTick) {
            maxTick = tick;
        }
    }

    if (division & 0x8000) {
        const smpte = (division >> 8) & 0xff;
        const framesPerSecond = 0x100 - smpte;
        const ticksPerFrame = division & 0xff;
        const ticksPerSecond = framesPerSecond * ticksPerFrame;
        const ms = ticksPerSecond > 0 ? Math.round((maxTick / ticksPerSecond) * 1000) : 0;
        return ms;
    }

    const ppq = division || 1;
    tempos.sort((a, b) => a.tick - b.tick || a.order - b.order);

    let currentTempo = 500000;
    let lastTick = 0;
    let totalUs = 0;

    for (const tempo of tempos) {
        if (tempo.tick < lastTick) {
            continue;
        }

        const deltaTicks = tempo.tick - lastTick;
        totalUs += (deltaTicks * currentTempo) / ppq;
        currentTempo = tempo.tempo;
        lastTick = tempo.tick;
    }

    if (maxTick > lastTick) {
        totalUs += ((maxTick - lastTick) * currentTempo) / ppq;
    }

    const ms = Math.round(totalUs / 1000);
    return ms;
}

// "attack1.mid" has a RIFF header
function unwrapRiffMidi(data: Uint8Array): Uint8Array | null {
    if (data.length < 12) {
        return data;
    }

    if (readChunkId(data, 0) !== 'RIFF') {
        return data;
    }

    if (readChunkId(data, 8) !== 'RMID') {
        return null;
    }

    let offset = 12;
    while (offset + 8 <= data.length) {
        const id = readChunkId(data, offset);
        const size = readU32LE(data, offset + 4);
        offset += 8;

        if (offset + size > data.length) {
            return null;
        }

        if (id === 'data') {
            return data.subarray(offset, offset + size);
        }

        offset += size + (size % 2);
    }

    return null;
}

export default class Midi {
    /**
     * Track id -> length in ms, filled in on first use.
     *
     * Reading a track means gunzipping it, and eagerly doing that for all 345 of
     * them at boot cost ~54MB of resident memory - malloc arenas that zlib grows
     * and never hands back - to keep 345 integers. A world plays a handful of
     * tracks, so compute them on demand instead.
     *
     * A stored 0 means "computed, and unusable", so a missing or corrupt track is
     * not re-read on every call. That is why this is a Map and not an array: with
     * `?? 0` there is no way to tell an absent entry from a zero one.
     */
    private static readonly lengths = new Map<number, number>();

    /** Drops the memoised lengths. Call when the cache underneath changes. */
    static reset(): void {
        Midi.lengths.clear();
    }

    private static compute(id: number): number {
        if (!Number.isInteger(id) || id < 0 || id >= OnDemand.cache.count(3)) {
            return 0;
        }

        let data: Uint8Array | null;
        try {
            // gunzipSync throws on a corrupt entry, and at boot that took the
            // whole world down with no handler
            data = OnDemand.cache.read(3, id, true);
        } catch (err) {
            printWarning(`Failed to read midi id=${id}: ${err}`);
            return 0;
        }

        if (!data) {
            printWarning(`Missing midi id=${id}`);
            return 0;
        }

        const length = parseMidiLength(data);
        if (!length) {
            printWarning(`Failed to parse midi id=${id}`);
            return 0;
        }

        return length;
    }

    static getLength(id: number): number {
        const cached = Midi.lengths.get(id);
        if (cached !== undefined) {
            return cached;
        }

        const length = Midi.compute(id);
        Midi.lengths.set(id, length);
        return length;
    }

    static getTickLength(id: number): number {
        return Math.ceil(this.getLength(id) / 600) + 1;
    }
}
