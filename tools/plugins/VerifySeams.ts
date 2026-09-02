import fs from 'fs';
import path from 'path';

/**
 * Every plugin seam in upstream engine files, and how many `@plugin-hook` markers each carries.
 * Seams are purely additive (an import line and a call line), so an upstream rebase can only ever
 * drop them, never silently corrupt them. Run this after every sync with upstream.
 *
 * Keep this list and PLUGINS.md in step when adding a seam.
 */
const SEAM_MANIFEST: { file: string; markers: number; hint: string }[] = [
    {
        file: 'src/network/game/client/handler/IdleTimerHandler.ts',
        markers: 2,
        hint: 'import Plugins, then `if (Plugins.onIdleTimer(player)) return true;` as the first line of handle()'
    },
    {
        file: 'src/engine/entity/Player.ts',
        markers: 2,
        hint: 'import Plugins, then `Plugins.onLogin(this);` at the end of onLogin(), just before `this.isActive = true;`'
    },
    {
        file: 'src/engine/World.ts',
        markers: 2,
        hint: 'import Plugins, then `Plugins.onCycle(this.currentTick);` as the first line inside the try in cycle()'
    }
];

const MARKER = '@plugin-hook';

function countMarkers(contents: string): number {
    return contents.split('\n').filter(line => line.includes(MARKER)).length;
}

let failed = false;

for (const seam of SEAM_MANIFEST) {
    const full = path.resolve(seam.file);

    if (!fs.existsSync(full)) {
        console.error(`MISSING FILE  ${seam.file}`);
        console.error('              upstream may have moved or deleted it - see PLUGINS.md');
        failed = true;
        continue;
    }

    const found = countMarkers(fs.readFileSync(full, 'utf8'));

    if (found === seam.markers) {
        console.log(`ok            ${seam.file} (${found}/${seam.markers})`);
        continue;
    }

    console.error(`SEAM LOST     ${seam.file} (${found}/${seam.markers} markers)`);
    console.error(`              re-add: ${seam.hint}`);
    failed = true;
}

if (failed) {
    console.error('\nOne or more plugin seams are missing. PLUGINS.md has the exact snippets.');
    process.exitCode = 1;
} else {
    console.log(`\nAll ${SEAM_MANIFEST.length} plugin seams present.`);
}
