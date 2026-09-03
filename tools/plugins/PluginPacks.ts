import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { PackFile } from '#tools/pack/PackFileBase.js';
import { PLUGIN_ID_BASE, PLUGIN_PACK_TYPES, PluginPackType, isPluginPackType } from '#tools/plugins/PluginIds.js';

/** One declared id from a plugin's `plugin.pack` fragment. */
export type PluginEntry = {
    type: PluginPackType;
    id: number;
    name: string;
    plugin: string;
    file: string;
    line: number;
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

    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
}

/**
 * Parse every plugin's fragment. Format is whitespace-separated `<type> <id> <name>`, with `#`
 * starting a comment. Fragments are the source of truth; `content/pack/*.pack` is derived.
 */
export function readFragments(): PluginEntry[] {
    const entries: PluginEntry[] = [];

    for (const plugin of listPlugins()) {
        const file = path.join(pluginsRoot(), plugin, 'plugin.pack');

        if (!fs.existsSync(file)) {
            continue;
        }

        const lines = fs.readFileSync(file, 'utf8').split('\n');

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

            const id = Number(rawId);

            if (!Number.isInteger(id) || id < 0) {
                throw new Error(`${file}:${i + 1}: "${rawId}" is not a valid id`);
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
