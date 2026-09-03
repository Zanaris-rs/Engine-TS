import fs from 'fs';

import { listPlugins, findDrift, packPath, readFragments } from '#tools/plugins/PluginPacks.js';

const check = process.argv.includes('--check');
const plugins = listPlugins();
const entries = readFragments();

console.log(`${plugins.length} plugin(s), ${entries.length} declared id(s)`);

const drift = findDrift(entries);

if (drift.length === 0) {
    console.log('content/pack is already in sync.');
    process.exit(0);
}

for (const { type, expected, actual } of drift) {
    const before = actual.length === 0 ? 0 : actual.trimEnd().split('\n').length;
    const after = expected.trimEnd().split('\n').length;

    if (check) {
        console.error(`DRIFT  ${type}.pack (${before} -> ${after} lines)`);
        continue;
    }

    fs.writeFileSync(packPath(type), expected);
    console.log(`wrote  ${type}.pack (${before} -> ${after} lines)`);
}

if (check) {
    console.error('\ncontent/pack is out of sync with the plugin fragments. Run: npx tsx tools/plugins/SyncPluginPacks.ts');
    process.exitCode = 1;
}
