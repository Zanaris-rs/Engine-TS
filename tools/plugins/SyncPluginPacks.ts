import fs from 'fs';

import { write as generateContent } from '#tools/plugins/GenerateContent.js';
import { listPlugins, findDrift, headroom, packPath, readFragments, readLock, resolve, upstreamRef, writeLock } from '#tools/plugins/PluginPacks.js';

const check = process.argv.includes('--check');
const plugins = listPlugins();
const raw = readFragments();
const { entries, lock, changed } = resolve(raw, readLock());

const autos = raw.filter(e => e.id === 'auto').length;
console.log(`${plugins.length} plugin(s), ${entries.length} declared id(s)${autos ? `, ${autos} allocated automatically` : ''}`);

if (changed && !check) {
    writeLock(lock);
    console.log('updated pack/plugin-ids.lock.json');
} else if (changed && check) {
    console.error('DRIFT  plugin-ids.lock.json is out of date');
    process.exitCode = 1;
}

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

if (!check) {
    const states = generateContent();
    const on = states.filter(s => s.enabled);
    const hooked = states.filter(s => s.hooks.length > 0);
    console.log(`generated flags for ${states.length} plugin(s), ${on.length} enabled${hooked.length ? `, ${hooked.length} with hooks` : ''}`);
    for (const s of states.filter(s => !s.enabled)) {
        console.log(`  disabled: ${s.name}`);
    }
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
