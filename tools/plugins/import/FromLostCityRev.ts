import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { readOb2 } from '#tools/plugins/Ob2.js';
import { PLUGIN_ID_BASE } from '#tools/plugins/PluginIds.js';
import { pluginsRoot, modelsRoot, readFragments } from '#tools/plugins/PluginPacks.js';

/**
 * Import a model from another Lost City revision branch into a plugin.
 *
 * The .ob2 format did not change across these revisions - model id 2373 is `inv_scimitar` on 289
 * and `obj_bronze_scimitar` on 377-wip, and the two files are byte-identical - so a cross-revision
 * port is a straight copy with no conversion. All this does is fetch the blob out of the other
 * branch and allocate it an id in the plugin's fragment.
 *
 * Usage:
 *   npx tsx tools/plugins/import/FromLostCityRev.ts \
 *     --plugin dragon_scimitar \
 *     --branch 377-wip \
 *     --model models/obj/obj_dragon_scimitar.ob2 \
 *     [--as plugin_dragon_scimitar]
 */
function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

const plugin = arg('plugin');
const branch = arg('branch');
const model = arg('model');

if (!plugin || !branch || !model) {
    console.error('usage: FromLostCityRev.ts --plugin <name> --branch <branch> --model <path/in/branch.ob2> [--as <name>]');
    process.exit(1);
}

const contentDir = path.resolve(Environment.build.srcDir);
const requested = arg('as') ?? path.basename(model, '.ob2');
// plugin assets are prefixed so they can never collide with an upstream rename
const name = requested.startsWith('plugin_') ? requested : `plugin_${requested}`;

let blob: Buffer;
try {
    blob = execFileSync('git', ['show', `${branch}:${model}`], { cwd: contentDir, maxBuffer: 64 * 1024 * 1024 });
} catch {
    console.error(`Could not read ${branch}:${model} from ${contentDir}`);
    console.error('Check the branch exists locally (git branch -a) and the path is correct.');
    process.exit(1);
}

const modelDir = path.join(modelsRoot(), plugin);
const scriptDir = path.join(pluginsRoot(), plugin);
fs.mkdirSync(modelDir, { recursive: true });
fs.mkdirSync(path.join(scriptDir, 'configs'), { recursive: true });
fs.mkdirSync(path.join(scriptDir, 'scripts'), { recursive: true });

const target = path.join(modelDir, `${name}.ob2`);
fs.writeFileSync(target, blob);

const fragment = path.join(scriptDir, 'plugin.pack');
const existing = readFragments();
const already = existing.find(e => e.type === 'model' && e.name === name);

let id: number;
if (already) {
    id = already.id;
    console.log(`reused model id ${id} for ${name} (already declared)`);
} else {
    const base = PLUGIN_ID_BASE.model;
    const used = existing.filter(e => e.type === 'model').map(e => e.id);
    id = used.length === 0 ? base : Math.max(base - 1, ...used) + 1;

    const header = fs.existsSync(fragment) ? '' : '# <type> <id> <name> - ids come from tools/plugins/PluginIds.ts\n';
    fs.appendFileSync(fragment, `${header}model ${id} ${name}\n`);
    console.log(`declared model ${id} ${name} in ${path.relative(process.cwd(), fragment)}`);
}

console.log(`wrote ${path.relative(process.cwd(), target)} (${blob.length} bytes)`);

const info = readOb2(blob);

if (!info.wellFormed) {
    console.error(`\nWARNING: ${name}.ob2 does not parse as an .ob2 (body ${info.actualLength} bytes, header describes ${info.expectedLength}).`);
} else if (info.rigged) {
    // geometry, colours and face indices are identical across revisions; rig labels are not
    const which = [info.hasVertexLabels ? 'VSKIN' : '', info.hasFaceLabels ? 'TSKIN' : ''].filter(Boolean).join('+');
    console.warn(`\nWARNING: this model is RIGGED (${which}).`);
    console.warn('Rig labels are re-assigned per model between revisions, so animating it with this');
    console.warn("revision's seqs will mangle it. Re-label it for 289 before use - see content/PLUGINS.md.");
}
console.log('\nnext: reference it from the plugin config, then run');
console.log('  npx tsx tools/plugins/SyncPluginPacks.ts && npx tsx tools/plugins/VerifyPluginPacks.ts');
