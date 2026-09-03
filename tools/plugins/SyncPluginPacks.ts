import fs from 'fs';

import { listPlugins, findDrift, headroom, packPath, readFragments, upstreamRef } from '#tools/plugins/PluginPacks.js';

const check = process.argv.includes('--check');
const plugins = listPlugins();
const entries = readFragments();

console.log(`${plugins.length} plugin(s), ${entries.length} declared id(s)`);

// Rebuilding a pack means deleting every id at or above the base, so refuse outright if
// upstream has grown into that range - otherwise this quietly destroys upstream content.
const collisions = headroom().filter(h => h.upstreamMax !== null && h.upstreamMax >= h.base);

if (collisions.length > 0) {
    for (const h of collisions) {
        console.error(`REFUSING  ${h.type}: upstream reaches ${h.upstreamMax} at ${upstreamRef()}, at or above the plugin base ${h.base}`);
        console.error(`          syncing would delete upstream entries between ${h.base} and ${h.upstreamMax}`);
    }
    console.error('\nRaise the affected bases in tools/plugins/PluginIds.ts, then re-run. See content/PLUGINS.md.');
    process.exit(1);
}

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
