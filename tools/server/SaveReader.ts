/**
 * A standalone reader for `data/players/<profile>/<name>.sav`.
 *
 * `src/engine/entity/PlayerLoading.ts` is the real one, and this mirrors its
 * version handling byte for byte - but it cannot be reused: constructing a
 * `Player` imports `World`, and importing `World` spawns worker threads. A
 * census tool that wants nothing but the items in a file has no business
 * starting an engine, so this reads the same bytes and stops at the
 * inventories.
 *
 * Keep this in step with `PlayerLoading.load` whenever the save format
 * changes: the field order up to the inventory block is what makes the offsets
 * line up, so a new field anywhere before it belongs here too.
 */
import InvType from '#/cache/config/InvType.js';
import Packet from '#/io/Packet.js';

export const SAV_MAGIC: number = 0x2004;
export const SAV_VERSION: number = 7;

/** InvType.SCOPE_PERM - the invs that survive a logout, and so exist. */
export const SCOPE_PERM: number = 1;

export interface SaveObj {
    id: number;
    count: number;
}

export interface InvMeta {
    size: number;
    scope: number;
}

/** What the reader needs to know about an inv type, however it was resolved. */
export type InvLookup = (type: number) => InvMeta | undefined;

export interface SaveContents {
    username: string;
    version: number;
    /** Permanent-scope inventories only, by inv type id, in save-file order. */
    inventories: Record<number, SaveObj[]>;
}

/**
 * The permanent invs as the current content pack numbers them, used only when
 * `data/pack/server/inv.dat` cannot be read. Sizes matter for saves older than
 * version 5 (which did not record them); from version 5 on the file carries
 * its own sizes and only the scope filter is doing any work here.
 */
export const FALLBACK_PERM_INVS: Record<number, InvMeta> = {
    93: { size: 28, scope: SCOPE_PERM }, // inv (backpack)
    94: { size: 14, scope: SCOPE_PERM }, // worn
    95: { size: 240, scope: SCOPE_PERM } // bank
};

/**
 * Inv metadata straight from the cache config. Returns null when the pack is
 * not there - on a machine with no build, or a cwd whose `data/pack` symlink is
 * missing - so the caller can say so and fall back rather than silently census
 * nothing.
 */
export function invLookupFromCache(dir: string): InvLookup | null {
    InvType.load(dir);

    if (InvType.count === 0) {
        return null;
    }

    return (type: number) => InvType.get(type) as InvMeta | undefined;
}

export function fallbackInvLookup(): InvLookup {
    return (type: number) => FALLBACK_PERM_INVS[type];
}

/**
 * Reads one save. Throws the same three errors `PlayerLoading.load` throws for
 * a file that is not a save, is from a newer engine, or is corrupt; the caller
 * decides whether one bad file stops a census.
 */
export function readSave(username: string, data: Uint8Array, invs: InvLookup): SaveContents {
    const sav = new Packet(data);
    const inventories: Record<number, SaveObj[]> = {};

    // a brand new account is saved as an empty file, and owns nothing
    if (sav.data.length < 2) {
        return { username, version: 0, inventories };
    }

    if (sav.g2() !== SAV_MAGIC) {
        throw new Error('Invalid save file');
    }

    const version = sav.g2();
    if (version > SAV_VERSION) {
        throw new Error('Unsupported save version');
    }

    sav.pos = sav.data.length - 4;
    const crc = sav.g4s();
    if (crc !== Packet.getcrc(sav.data, 0, sav.data.length - 4)) {
        throw new Error('Incorrect save checksum');
    }

    sav.pos = 4;

    // x, z, level
    sav.pos += 5;
    // body (7), colors (5), gender
    sav.pos += 13;
    // runenergy
    sav.pos += 2;
    // playtime: g4s from version 2 on, g2 before it
    sav.pos += version >= 2 ? 4 : 2;

    // 21 stats, each an exp int and a boosted level byte
    sav.pos += 21 * 5;

    const varpCount = sav.g2();
    if (version >= 7) {
        // sparse: id then a variable-width value, so it has to be walked
        for (let i = 0; i < varpCount; i++) {
            sav.pos += 2;
            sav.gVarInt();
        }
    } else {
        sav.pos += varpCount * 4;
    }

    const invCount = sav.g1();
    for (let i = 0; i < invCount; i++) {
        const type = sav.g2();
        const meta = invs(type);

        if (version < 5 && !meta) {
            // the size is not in the file and nothing here knows it, so every
            // byte after this point is unreadable - guessing would silently
            // produce a wrong census
            throw new Error(`Unknown inv ${type} in a version ${version} save: no size in the file and no inv config to supply one`);
        }

        const size = version >= 5 ? sav.g2() : meta!.size;

        const objs: SaveObj[] = [];
        for (let slot = 0; slot < size; slot++) {
            const id = sav.g2() - 1;
            if (id === -1) {
                // an empty slot is the id alone: no count follows
                continue;
            }

            let count = sav.g1();
            if (count === 255) {
                count = sav.g4s();
            }

            objs.push({ id, count });
        }

        if (meta?.scope !== SCOPE_PERM) {
            // temp and shared invs are not anybody's property: shop stock and
            // the like are rebuilt from the config every startup
            continue;
        }

        const existing = inventories[type];
        if (existing) {
            existing.push(...objs);
        } else {
            inventories[type] = objs;
        }
    }

    return { username, version, inventories };
}
