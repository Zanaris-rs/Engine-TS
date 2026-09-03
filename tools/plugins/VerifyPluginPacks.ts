import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { PackFile } from '#tools/pack/PackFileBase.js';
import { PLUGIN_ID_BASE, PLUGIN_ID_CEILING, PLUGIN_PACK_TYPES } from '#tools/plugins/PluginIds.js';
import { readOb2 } from '#tools/plugins/Ob2.js';
import { PluginEntry, findDrift, listPlugins, modelsRoot, readFragments } from '#tools/plugins/PluginPacks.js';

let failed = false;
let warnings = 0;

function fail(message: string, detail?: string) {
    console.error(`FAIL  ${message}`);
    if (detail) {
        console.error(`      ${detail}`);
    }
    failed = true;
}

function ok(message: string) {
    console.log(`ok    ${message}`);
}

function warn(message: string, detail?: string) {
    console.warn(`WARN  ${message}`);
    if (detail) {
        console.warn(`      ${detail}`);
    }
    warnings++;
}

function where(entry: PluginEntry): string {
    return `${entry.file}:${entry.line}`;
}

const plugins = listPlugins();
const entries = readFragments();

if (plugins.length === 0) {
    console.log('No content plugins installed.');
    process.exit(0);
}

// 1 + 2: every declared id sits inside its type's reserved window
for (const entry of entries) {
    const base = PLUGIN_ID_BASE[entry.type];
    const ceiling = PLUGIN_ID_CEILING[entry.type];

    if (entry.id < base) {
        fail(`${entry.type} ${entry.id} (${entry.name}) is below the plugin base ${base}`, `${where(entry)} - ids below the base belong to upstream`);
    } else if (entry.id >= ceiling) {
        const why = entry.type === 'npc' ? 'npc ids are 11 bits and mask silently above 2047' : 'the packer index buffer holds 50,000 entries';
        fail(`${entry.type} ${entry.id} (${entry.name}) is at or above the ceiling ${ceiling}`, `${where(entry)} - ${why}`);
    }
}
if (!failed) {
    ok(`${entries.length} declared id(s) within their reserved ranges`);
}

// 3: no id claimed twice within a type, no name claimed twice at all
const seenId = new Map<string, PluginEntry>();
const seenName = new Map<string, PluginEntry>();
for (const entry of entries) {
    const idKey = `${entry.type}:${entry.id}`;
    const previousId = seenId.get(idKey);
    if (previousId) {
        fail(`${entry.type} id ${entry.id} declared twice`, `${where(previousId)} and ${where(entry)}`);
    }
    seenId.set(idKey, entry);

    const previousName = seenName.get(entry.name);
    if (previousName) {
        fail(`name "${entry.name}" declared twice`, `${where(previousName)} and ${where(entry)}`);
    }
    seenName.set(entry.name, entry);
}

// 4: a declared name must not already exist upstream - PackFile.register silently rebinds a
// duplicate name to the new id, which would quietly repoint upstream content at plugin data
for (const type of PLUGIN_PACK_TYPES) {
    const upstream = new PackFile(type);
    const base = PLUGIN_ID_BASE[type];

    for (const entry of entries.filter(e => e.type === type)) {
        const existing = upstream.getByName(entry.name);

        if (existing !== -1 && existing < base) {
            fail(`${type} name "${entry.name}" already exists upstream as id ${existing}`, `${where(entry)} - rename the plugin asset (a duplicate name silently rebinds)`);
        }
    }
}

// 5: content/pack matches what the fragments describe
const drift = findDrift(entries);
if (drift.length > 0) {
    fail(`content/pack is stale for: ${drift.map(d => d.type).join(', ')}`, 'run: npx tsx tools/plugins/SyncPluginPacks.ts');
} else {
    ok('content/pack matches the plugin fragments');
}

// 6: every declared model has a file, and every plugin model file is declared
const declaredModels = new Map<string, PluginEntry>();
for (const entry of entries.filter(e => e.type === 'model')) {
    declaredModels.set(entry.name, entry);

    const file = path.join(modelsRoot(), entry.plugin, `${entry.name}.ob2`);
    if (!fs.existsSync(file)) {
        fail(`model "${entry.name}" has no file`, `${where(entry)} - expected ${path.relative(process.cwd(), file)}`);
        continue;
    }

    const model = readOb2(fs.readFileSync(file));

    if (!model.wellFormed) {
        fail(`model "${entry.name}.ob2" does not parse as an .ob2`, `body is ${model.actualLength} bytes, header describes ${model.expectedLength}`);
    } else if (model.rigged) {
        // rig labels are re-assigned per model between revisions, so an imported rigged model
        // animates into mangled limbs unless it has been re-labelled for this revision
        const which = [model.hasVertexLabels ? 'VSKIN' : '', model.hasFaceLabels ? 'TSKIN' : ''].filter(Boolean).join('+');
        warn(`model "${entry.name}.ob2" is rigged (${which})`, 'if imported from another revision it must be re-labelled for 289 or it will animate wrongly - see content/PLUGINS.md');
    }
}

if (fs.existsSync(modelsRoot())) {
    for (const plugin of fs.readdirSync(modelsRoot(), { withFileTypes: true }).filter(e => e.isDirectory())) {
        const dir = path.join(modelsRoot(), plugin.name);

        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ob2'))) {
            const name = path.basename(file, '.ob2');

            if (!declaredModels.has(name)) {
                // an undeclared .ob2 is a hard build failure in validateFilesPack, so catch it here
                fail(`model file "${name}.ob2" is not declared in any plugin.pack`, `${path.relative(process.cwd(), path.join(dir, file))}`);
            }
        }
    }
}
if (!failed) {
    ok(`${declaredModels.size} model file(s) match their declarations`);
}

// 7: adding any transmitted config fails the packer's CRC gate unless verify is off
if (Environment.build.verify) {
    fail('build.verify is true, which rejects any added obj/npc/loc', 'set "build": { "verify": false } in engine/data/config/world.json');
} else {
    ok('build.verify is false');
}

if (failed) {
    console.error('\nPlugin pack verification failed. See content/PLUGINS.md.');
    process.exitCode = 1;
} else if (warnings > 0) {
    console.log(`\nAll checks passed for ${plugins.length} plugin(s), with ${warnings} warning(s).`);
} else {
    console.log(`\nAll checks passed for ${plugins.length} plugin(s).`);
}
