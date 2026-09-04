import { readManifest } from '#tools/plugins/Manifest.js';
import { importModel, reportImport } from '#tools/plugins/import/ImportModel.js';

/**
 * Import a plugin's models from another Lost City revision branch.
 *
 *   --plugin <name> --from-manifest                    everything plugin.json declares
 *   --plugin <name> --branch <b> --model <p> [--as <n>]  one model
 */
function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
}

const plugin = arg('plugin');

if (!plugin) {
    console.error('usage: FromLostCityRev.ts --plugin <name> [--from-manifest | --branch <b> --model <path.ob2> [--as <name>]]');
    process.exit(1);
}

const wanted: { branch: string; model: string; as?: string }[] = [];

if (process.argv.includes('--from-manifest')) {
    const manifest = readManifest(plugin);

    if (!manifest) {
        console.error(`${plugin} has no plugin.json to read assets from`);
        process.exit(1);
    }

    for (const asset of manifest.assets ?? []) {
        wanted.push({ branch: asset.from, model: asset.model, as: asset.as });
    }

    if (wanted.length === 0) {
        console.log(`${plugin} declares no assets`);
        process.exit(0);
    }
} else {
    const branch = arg('branch');
    const model = arg('model');

    if (!branch || !model) {
        console.error('usage: FromLostCityRev.ts --plugin <name> [--from-manifest | --branch <b> --model <path.ob2> [--as <name>]]');
        process.exit(1);
    }

    wanted.push({ branch, model, as: arg('as') });
}

console.log(`importing ${wanted.length} model(s) for ${plugin}`);

for (const item of wanted) {
    reportImport(importModel(plugin, item.branch, item.model, item.as));
}

console.log('\nnext: npx tsx tools/plugins/SyncPluginPacks.ts && npx tsx tools/plugins/VerifyPluginPacks.ts');
