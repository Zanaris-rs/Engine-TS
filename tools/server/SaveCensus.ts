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
    /**
     * `<file>: <why>` - for the operator's eyes only, these name accounts.
     *
     * A save whose contents the reader refused, and also one the filesystem
     * refused: a file that vanished between the readdir and the read, one this
     * process may not open, a disk that went away. Both are the same fact as
     * far as a census is concerned - a player whose items were not counted.
     */
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

    /**
     * One attempt at one file. `false` means "come back later" - it is still
     * being written; `true` means it is finished with, either summed or
     * recorded as unreadable.
     *
     * Everything the filesystem can raise lands in `unreadable` rather than
     * out of this function: a save deleted between the readdir and the stat
     * (ENOENT - the player logged out and the login server moved it, or an
     * operator did), a file this process may not open, a disk that went away
     * mid-read. One of those used to end the whole run with a stack trace and
     * no census at all, which is the wrong trade by a distance - the caller
     * already knows what a census that missed a file means, and already refuses
     * to write flow rows for one. An hour with one bad file should cost that
     * file, not the hour.
     */
    const attempt = (name: string, retried: boolean): boolean => {
        const file = path.join(dir, name);

        try {
            const read = readSettled(file, settleMs);

            if (!read) {
                // its mtime is still the reason to come back, and it is read
                // again below rather than left out of the census
                note(fs.statSync(file).mtimeMs);
                return false;
            }

            note(read.mtimeMs);

            if (retried) {
                result.settled++;
            }

            sum(name, read.data);
        } catch (err) {
            result.unreadable.push(`${name}: ${(err as Error).message}`);
        }

        return true;
    };

    let pending: string[] = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.sav')) {
            continue;
        }

        result.players++;

        if (!attempt(entry.name, false)) {
            pending.push(entry.name);
        }
    }

    for (let round = 1; round <= attempts && pending.length > 0; round++) {
        options.onWait?.(pending.length, round, waitMs);
        await sleep(waitMs);

        const stillPending: string[] = [];
        for (const name of pending) {
            if (!attempt(name, true)) {
                stillPending.push(name);
            }
        }

        pending = stillPending;
    }

    result.unsettled = pending;

    return result;
}
