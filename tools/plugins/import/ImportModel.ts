import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { readOb2 } from '#tools/plugins/Ob2.js';
import { modelsRoot, pluginsRoot, readFragments } from '#tools/plugins/PluginPacks.js';

export type ImportResult = {
    name: string;
    file: string;
    bytes: number;
    rigged: boolean;
    wellFormed: boolean;
    declared: boolean;
};

/**
 * Copy a model out of another revision branch of the content repo.
 *
 * The `.ob2` format did not change across these revisions - model id 2373 is `inv_scimitar` on 289
 * and `obj_bronze_scimitar` on 377-wip, and the two files are byte-identical - so this is a plain
 * copy with no conversion. What it is *not* safe for is rigged models: labels belong to the
 * revision they came from, so a full humanoid will deform. The caller is told, rather than this
 * refusing, because a model bound to few groups (a held weapon) usually looks fine.
 */
export function importModel(plugin: string, branch: string, model: string, asName?: string): ImportResult {
    const contentDir = path.resolve(Environment.build.srcDir);
    const requested = asName ?? path.basename(model, '.ob2');
    // plugin assets are prefixed so they can never collide with an upstream rename
    const name = requested.startsWith('plugin_') ? requested : `plugin_${requested}`;

    let blob: Buffer;
    try {
        blob = execFileSync('git', ['show', `${branch}:${model}`], { cwd: contentDir, maxBuffer: 64 * 1024 * 1024 });
    } catch {
        throw new Error(`could not read ${branch}:${model} from ${contentDir} - check the branch exists locally (git branch -a) and the path is right`);
    }

    const modelDir = path.join(modelsRoot(), plugin);
    const scriptDir = path.join(pluginsRoot(), plugin);
    fs.mkdirSync(modelDir, { recursive: true });
    fs.mkdirSync(path.join(scriptDir, 'configs'), { recursive: true });
    fs.mkdirSync(path.join(scriptDir, 'scripts'), { recursive: true });

    const file = path.join(modelDir, `${name}.ob2`);
    fs.writeFileSync(file, blob);

    // declare the symbol if it is new; `auto` because the id belongs to the installing server
    const fragment = path.join(scriptDir, 'plugin.pack');
    const declared = readFragments().some(e => e.type === 'model' && e.name === name);

    if (!declared) {
        const header = fs.existsSync(fragment) ? '' : '# <type> <id|auto> <name>\n';
        fs.appendFileSync(fragment, `${header}model auto ${name}\n`);
    }

    const info = readOb2(blob);

    return { name, file, bytes: blob.length, rigged: info.rigged, wellFormed: info.wellFormed, declared: !declared };
}

export function reportImport(result: ImportResult): void {
    console.log(`  ${result.name} (${result.bytes} bytes)${result.declared ? ' - declared' : ''}`);

    if (!result.wellFormed) {
        console.error('    WARNING: does not parse as an .ob2');
    } else if (result.rigged) {
        console.warn('    note: rigged, so its labels belong to the revision it came from - a full humanoid will deform, a held weapon usually looks fine');
    }
}
