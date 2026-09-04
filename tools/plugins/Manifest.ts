import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { listPlugins, pluginsRoot } from '#tools/plugins/PluginPacks.js';

/**
 * `plugin.json` - what a plugin says about itself.
 *
 * The field that earns its keep is `revision`. Ids are per-revision: npc and loc both have to move
 * between 289 and 377, and a plugin built against one will not merely fail on the other, it will
 * half-work - content resolving to whatever now occupies those ids. Refusing at install is the
 * only honest option.
 *
 * `assets` makes a plugin a recipe rather than a copy. Rather than shipping extracted `.ob2`
 * files, a plugin says where they come from and the installing server imports them from its own
 * content checkout.
 */
export type AssetSource = {
    /** A branch of the content repo, e.g. "377-wip". */
    from: string;
    /** Path to the model within that branch. */
    model: string;
    /** The name it is registered under here. */
    as: string;
};

export type Manifest = {
    name: string;
    version: string;
    description: string;
    /** The content revision this plugin's ids and configs were written against. */
    revision: number;
    authors?: string[];
    license?: string;
    repository?: string;
    /** Other plugins that must be installed, as name -> minimum version. */
    requires?: Record<string, string>;
    assets?: AssetSource[];
};

export type ManifestProblem = { plugin: string; message: string; hint?: string };

const NAME = /^[a-z][a-z0-9_]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function manifestPath(plugin: string): string {
    return path.join(pluginsRoot(), plugin, 'plugin.json');
}

export function readManifest(plugin: string): Manifest | null {
    const file = manifestPath(plugin);

    if (!fs.existsSync(file)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
}

/** Compare `1.2.3` strings. Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
            return (pa[i] ?? 0) - (pb[i] ?? 0);
        }
    }

    return 0;
}

function satisfies(version: string, constraint: string): boolean {
    const trimmed = constraint.trim();

    if (trimmed.startsWith('>=')) {
        return compareVersions(version, trimmed.slice(2).trim()) >= 0;
    }

    return compareVersions(version, trimmed) === 0;
}

/**
 * Validate every installed plugin's manifest, including how they relate to each other.
 * Returns the problems rather than throwing, so a caller can report them all at once.
 */
export function validateManifests(enabled: (plugin: string) => boolean): { manifests: Map<string, Manifest>; problems: ManifestProblem[] } {
    const manifests = new Map<string, Manifest>();
    const problems: ManifestProblem[] = [];

    for (const plugin of listPlugins()) {
        let manifest: Manifest | null;

        try {
            manifest = readManifest(plugin);
        } catch (err) {
            problems.push({ plugin, message: `plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
            continue;
        }

        if (!manifest) {
            problems.push({ plugin, message: 'has no plugin.json', hint: `create ${path.relative(process.cwd(), manifestPath(plugin))} with name, version, description and revision` });
            continue;
        }

        for (const field of ['name', 'version', 'description', 'revision'] as const) {
            if (manifest[field] === undefined) {
                problems.push({ plugin, message: `plugin.json is missing "${field}"` });
            }
        }

        if (manifest.name !== undefined && manifest.name !== plugin) {
            problems.push({ plugin, message: `plugin.json says name "${manifest.name}" but the directory is "${plugin}"`, hint: 'the name addresses the plugin in config and generated constants, so they have to agree' });
        }

        if (manifest.name !== undefined && !NAME.test(manifest.name)) {
            problems.push({ plugin, message: `"${manifest.name}" is not a usable name`, hint: 'lowercase letters, digits and underscores, starting with a letter - it becomes part of a generated constant' });
        }

        if (manifest.version !== undefined && !VERSION.test(manifest.version)) {
            problems.push({ plugin, message: `version "${manifest.version}" is not major.minor.patch` });
        }

        if (manifest.revision !== undefined && manifest.revision !== Environment.engine.revision) {
            problems.push({
                plugin,
                message: `targets revision ${manifest.revision}, but this server is ${Environment.engine.revision}`,
                hint: 'ids are per-revision - npc and loc both move between 289 and 377, so this would half-work rather than fail'
            });
        }

        if (manifest.name !== undefined) {
            manifests.set(manifest.name, manifest);
        }
    }

    // dependencies, once every manifest is known
    for (const [name, manifest] of manifests) {
        for (const [dep, constraint] of Object.entries(manifest.requires ?? {})) {
            const found = manifests.get(dep);

            if (!found) {
                problems.push({ plugin: name, message: `requires "${dep}", which is not installed` });
                continue;
            }

            if (!enabled(dep)) {
                problems.push({ plugin: name, message: `requires "${dep}", which is installed but disabled` });
                continue;
            }

            if (!satisfies(found.version, constraint)) {
                problems.push({ plugin: name, message: `requires ${dep} ${constraint}, but ${found.version} is installed` });
            }
        }
    }

    return { manifests, problems };
}
