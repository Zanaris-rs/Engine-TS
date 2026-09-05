/**
 * Scanning a directory of save files and summing what is in them.
 *
 * The part worth explaining is the settle window. The login server writes
 * `data/players/<profile>/<name>.sav` in place (`fsp.writeFile`, not a write to
 * a temporary file and a rename), so a file touched this instant can be half of
 * the old save and half of the new one. The crc catches most of that, but not a
 * torn write that happens to checksum.
 *
 * So a save younger than `settleMs` is not skipped - a snapshot must never be
 * knowingly short, because the run after it would then read the missing items
 * as having entered the game - it is set aside, waited on, and read again. Only
 * a file still being written after every attempt is left out, and the caller is
 * told, so it can suppress the flow rows exactly as it does for a file it could
 * not read at all.
 */
import fs from 'fs';
import path from 'path';

import { InvLookup, readSave } from '#tools/server/SaveReader.js';

/** How new a file has to be to be suspected of still being written. */
export const SETTLE_MS = 1000;

/** How long to wait before looking at a suspect file again. */
export const SETTLE_WAIT_MS = 1500;

/** How many times to go back to a file that was still being written. */
export const SETTLE_ATTEMPTS = 2;

export interface CensusOptions {
    settleMs?: number;
    waitMs?: number;
    attempts?: number;
    /** Called before each wait, so a caller can say what it is waiting for. */
    onWait?: (pending: number, attempt: number, waitMs: number) => void;
}

export interface CensusResult {
    /** save files found: each one is a player, censused or not */
    players: number;
    /** save files summed into `items` */
    censused: number;
    /** how many of those needed a second look before they settled */
    settled: number;
    /** `<file>: <why>` - for the operator's eyes only, these name accounts */
    unreadable: string[];
    /** files still being written after every attempt - names, likewise */
    unsettled: string[];
    newestSave: Date | null;
    items: Map<number, number>;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reads a file only if it is not being written to. Null means "come back
 * later": either the file is younger than the settle window, or it changed
 * underneath the read, which is the same problem caught a moment later.
 */
function readSettled(file: string, settleMs: number): { data: Uint8Array; mtimeMs: number } | null {
    const before = fs.statSync(file);
    if (Date.now() - before.mtimeMs < settleMs) {
        return null;
    }

    const data = new Uint8Array(fs.readFileSync(file));

    const after = fs.statSync(file);
    if (after.mtimeMs !== before.mtimeMs) {
        return null;
    }

    return { data, mtimeMs: after.mtimeMs };
}

export async function censusSaves(dir: string, invs: InvLookup, options: CensusOptions = {}): Promise<CensusResult> {
    const settleMs = options.settleMs ?? SETTLE_MS;
    const waitMs = options.waitMs ?? SETTLE_WAIT_MS;
    const attempts = options.attempts ?? SETTLE_ATTEMPTS;

    const result: CensusResult = { players: 0, censused: 0, settled: 0, unreadable: [], unsettled: [], newestSave: null, items: new Map() };

    const sum = (name: string, data: Uint8Array) => {
        let save;
        try {
            save = readSave(name.slice(0, -4), data, invs);
        } catch (err) {
            result.unreadable.push(`${name}: ${(err as Error).message}`);
            return;
        }

        result.censused++;

        for (const objs of Object.values(save.inventories)) {
            for (const obj of objs) {
                result.items.set(obj.id, (result.items.get(obj.id) ?? 0) + obj.count);
            }
        }
    };

    const note = (mtimeMs: number) => {
        if (!result.newestSave || mtimeMs > result.newestSave.getTime()) {
            result.newestSave = new Date(mtimeMs);
        }
    };

    let pending: string[] = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.sav')) {
            continue;
        }

        result.players++;

        const read = readSettled(path.join(dir, entry.name), settleMs);
        if (!read) {
            // its mtime is still the reason to come back, and it is read again
            // below rather than left out of the census
            note(fs.statSync(path.join(dir, entry.name)).mtimeMs);
            pending.push(entry.name);
            continue;
        }

        note(read.mtimeMs);
        sum(entry.name, read.data);
    }

    for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt++) {
        options.onWait?.(pending.length, attempt, waitMs);
        await sleep(waitMs);

        const stillPending: string[] = [];
        for (const name of pending) {
            const read = readSettled(path.join(dir, name), settleMs);
            if (!read) {
                note(fs.statSync(path.join(dir, name)).mtimeMs);
                stillPending.push(name);
                continue;
            }

            note(read.mtimeMs);
            result.settled++;
            sum(name, read.data);
        }

        pending = stillPending;
    }

    result.unsettled = pending;

    return result;
}
