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
    },
    {
        // content seams: RuneScript triggers are single-owner, so core has to call the generated
        // dispatcher for plugins to react to login or logout at all
        file: '../content/scripts/login_logout/login.rs2',
        markers: 1,
        hint: '`~plugin_login;` in [login,_], ABOVE the tutorial branch - that branch ends in @start_tutorial, a tail jump, so anything after it never runs for new players'
    },
    {
        file: '../content/scripts/login_logout/logout.rs2',
        markers: 1,
        hint: '`~plugin_logout;` at the end of [logout,_]'
    },
    {
        // upstream's own CI builds against the upstream engine with the CRC gate on, which no
        // longer matches once plugins add configs - by design
        file: '../content/.github/workflows/content.yml',
        markers: 3,
        hint: 'point "Clone Engine" at the fork (repository + ref), and add a "Configure the build" step writing build.verify false'
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
