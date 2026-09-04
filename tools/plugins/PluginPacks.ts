import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { PackFile } from '#tools/pack/PackFileBase.js';
import { PLUGIN_ID_BASE, PLUGIN_ID_CEILING, PLUGIN_PACK_TYPES, PluginPackType, isPluginPackType } from '#tools/plugins/PluginIds.js';

/** One declared id from a plugin's `plugin.pack` fragment, before allocation. */
export type RawEntry = {
    type: PluginPackType;
    /** A fixed id, or `auto` to let the installing server pick one. */
    id: number | 'auto';
    name: string;
    plugin: string;
    file: string;
    line: number;
};

/** A fragment entry with its id decided. */
export type PluginEntry = RawEntry & { id: number };

/**
 * Which id each symbol was given, so it never moves.
 *
 * Ids leak into player saves - an obj id in a bank, a varp holding quest progress - so an id that
 * shifts silently rewrites what players own. Removed symbols are tombstoned rather than freed for
 * the same reason: reusing an id would alias a deleted item onto a new one in existing saves.
 *
 * This file is not derived. Losing it reshuffles every auto id, so commit it.
 */
export type Lock = {
    version: number;
    assigned: Partial<Record<PluginPackType, Record<string, number>>>;
    tombstoned: Partial<Record<PluginPackType, Record<string, number>>>;
};

export function pluginsRoot(): string {
    return path.resolve(`${Environment.build.srcDir}/scripts/plugins`);
}

export function modelsRoot(): string {
    return path.resolve(`${Environment.build.srcDir}/models/plugins`);
}

export function packPath(type: PluginPackType): string {
    return path.resolve(`${Environment.build.srcDir}/pack/${type}.pack`);
}

export function listPlugins(): string[] {
    const root = pluginsRoot();

    if (!fs.existsSync(root)) {
        return [];
    }

    return (
        fs
            .readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            // _generated holds derived flags and dispatchers, not a plugin
            .filter(name => !name.startsWith('_'))
            .sort()
    );
}

/**
 * Parse every plugin's fragment. Format is whitespace-separated `<type> <id> <name>`, with `#`
 * starting a comment. Fragments are the source of truth; `content/pack/*.pack` is derived.
 */
export function readFragments(): RawEntry[] {
    const entries: RawEntry[] = [];

    for (const plugin of listPlugins()) {
        const file = path.join(pluginsRoot(), plugin, 'plugin.pack');

        if (!fs.existsSync(file)) {
            continue;
        }

        entries.push(...parseFragment(fs.readFileSync(file, 'utf8'), plugin, file));
    }

    return entries;
}

/** Split out so the parsing rules can be tested without a content tree. */
export function parseFragment(text: string, plugin: string, file: string): RawEntry[] {
    const entries: RawEntry[] = [];
    {
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].split('#')[0].trim();

            if (line.length === 0) {
                continue;
            }

            const parts = line.split(/\s+/);

            if (parts.length !== 3) {
                throw new Error(`${file}:${i + 1}: expected "<type> <id> <name>", got "${lines[i].trim()}"`);
            }

            const [type, rawId, name] = parts;

            if (!isPluginPackType(type)) {
                throw new Error(`${file}:${i + 1}: unknown pack type "${type}" (expected one of ${PLUGIN_PACK_TYPES.join(', ')})`);
            }

            let id: number | 'auto';

            if (rawId === 'auto') {
                id = 'auto';
            } else {
                id = Number(rawId);

                if (!Number.isInteger(id) || id < 0) {
                    throw new Error(`${file}:${i + 1}: "${rawId}" is not a valid id (use a number, or "auto")`);
                }
            }

            entries.push({ type, id, name, plugin, file, line: i + 1 });
        }
    }

    return entries;
}

/** Serialise exactly the way `PackFile.save()` does, so a sync is a byte-for-byte no-op. */
export function serialize(pack: PackFile): string {
    return (
        Array.from(pack.pack.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([id, name]) => `${id}=${name}`)
            .join('\n') + '\n'
    );
}

/**
 * Rebuild one pack from upstream's entries plus the declared plugin entries.
 *
 * Every id at or above the base is dropped first, so removing a plugin directory and re-running
 * the sync cleanly removes its lines. Ids below the base are never touched, so this can't damage
 * upstream data.
 */
export function buildPack(type: PluginPackType, entries: PluginEntry[]): PackFile {
    // no validator: a plain load of content/pack/<type>.pack, skipping the content crawl
    const pack = new PackFile(type);
    const base = PLUGIN_ID_BASE[type];

    for (const id of Array.from(pack.pack.keys())) {
        if (id >= base) {
            pack.delete(id);
        }
    }

    for (const entry of entries.filter(e => e.type === type)) {
        pack.register(entry.id, entry.name);
    }

    pack.refreshNames();
    return pack;
}

export type PackDrift = {
    type: PluginPackType;
    expected: string;
    actual: string;
};

/** Types whose on-disk pack does not match what the fragments describe. */
export function findDrift(entries: PluginEntry[]): PackDrift[] {
    const drift: PackDrift[] = [];

    for (const type of PLUGIN_PACK_TYPES) {
        const expected = serialize(buildPack(type, entries));
        const file = packPath(type);
        const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

        if (expected !== actual) {
            drift.push({ type, expected, actual });
        }
    }

    return drift;
}

export type Headroom = {
    type: PluginPackType;
    base: number;
    ceiling: number;
    /** Highest id upstream uses at this revision, or null if we could not read it. */
    upstreamMax: number | null;
    /** Ids between upstream's highest and our base. Negative means they overlap. */
    clearance: number | null;
    slots: number;
};

/** The upstream branch for the revision we are building, e.g. `upstream/289`. */
export function upstreamRef(): string {
    return `upstream/${Environment.engine.revision}`;
}

/**
 * How much room is left between upstream's content and each plugin base.
 *
 * This is the invariant the whole scheme rests on. SyncPluginPacks rebuilds a pack by deleting
 * every id at or above the base and re-registering the declared ones, which is only safe while
 * the base sits above everything upstream uses. A revision bump can quietly break that - at
 * revision 377 upstream locs reach 14973, well past a base of 12000 - and the sync would then
 * delete thousands of upstream entries and still build cleanly.
 *
 * Read from the upstream branch rather than the working pack, because the working pack has
 * already had our ids merged into it and cannot answer the question.
 */
export function headroom(): Headroom[] {
    const contentDir = path.resolve(Environment.build.srcDir);
    const ref = upstreamRef();

    return PLUGIN_PACK_TYPES.map(type => {
        const base = PLUGIN_ID_BASE[type];
        const ceiling = PLUGIN_ID_CEILING[type];
        let upstreamMax: number | null = null;

        try {
            const raw = execFileSync('git', ['show', `${ref}:pack/${type}.pack`], {
                cwd: contentDir,
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'ignore']
            });

            for (const line of raw.split('\n')) {
                const id = parseInt(line, 10);
                if (Number.isInteger(id) && line.includes('=')) {
                    upstreamMax = upstreamMax === null ? id : Math.max(upstreamMax, id);
                }
            }
        } catch {
            // ref not fetched, or the pack does not exist at that revision
        }

        return {
            type,
            base,
            ceiling,
            upstreamMax,
            clearance: upstreamMax === null ? null : base - upstreamMax - 1,
            slots: ceiling - base
        };
    });
}

export function lockPath(): string {
    return path.resolve(`${Environment.build.srcDir}/pack/plugin-ids.lock.json`);
}

export function readLock(): Lock {
    if (!fs.existsSync(lockPath())) {
        return { version: 1, assigned: {}, tombstoned: {} };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as Lock;
        return { version: parsed.version ?? 1, assigned: parsed.assigned ?? {}, tombstoned: parsed.tombstoned ?? {} };
    } catch {
        throw new Error(`${lockPath()} is not readable JSON. It records which id every plugin symbol was given; do not delete it.`);
    }
}

export function writeLock(lock: Lock): void {
    fs.writeFileSync(lockPath(), JSON.stringify(lock, null, 4) + '\n');
}

/**
 * Decide an id for every `auto` symbol.
 *
 * Assignments are sticky: once a symbol has an id it keeps it, so plugins can be shared without
 * their ids being a property of the author's machine. Ids already taken by fixed declarations,
 * live assignments, or tombstones are never handed out again.
 */
export function resolve(raw: RawEntry[], lock: Lock): { entries: PluginEntry[]; lock: Lock; changed: boolean } {
    const next: Lock = { version: 1, assigned: { ...lock.assigned }, tombstoned: { ...lock.tombstoned } };
    let changed = false;
    const entries: PluginEntry[] = [];

    for (const type of PLUGIN_PACK_TYPES) {
        const ofType = raw.filter(e => e.type === type);
        if (ofType.length === 0) {
            continue;
        }

        const assigned = { ...(next.assigned[type] ?? {}) };
        const tombstoned = next.tombstoned[type] ?? {};
        const taken = new Set<number>([...ofType.filter(e => e.id !== 'auto').map(e => e.id as number), ...Object.values(assigned), ...Object.values(tombstoned)]);

        for (const entry of ofType) {
            if (entry.id !== 'auto') {
                entries.push(entry as PluginEntry);
                continue;
            }

            let id = assigned[entry.name];

            if (id === undefined) {
                id = PLUGIN_ID_BASE[type];
                while (taken.has(id)) {
                    id++;
                }

                if (id >= PLUGIN_ID_CEILING[type]) {
                    throw new Error(`${entry.file}:${entry.line}: no ${type} ids left - the range ${PLUGIN_ID_BASE[type]}..${PLUGIN_ID_CEILING[type] - 1} is full`);
                }

                assigned[entry.name] = id;
                taken.add(id);
                changed = true;
            }

            entries.push({ ...entry, id });
        }

        // a symbol that is no longer declared keeps its id reserved forever
        for (const [name, id] of Object.entries(assigned)) {
            if (!ofType.some(e => e.name === name)) {
                delete assigned[name];
                next.tombstoned[type] = { ...(next.tombstoned[type] ?? {}), [name]: id };
                changed = true;
            }
        }

        next.assigned[type] = assigned;
    }

    return { entries, lock: next, changed };
}
