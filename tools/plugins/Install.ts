import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Environment from '#/util/Environment.js';
import { Manifest } from '#tools/plugins/Manifest.js';
import { modelsRoot, pluginsRoot } from '#tools/plugins/PluginPacks.js';
import { importModel, reportImport } from '#tools/plugins/import/ImportModel.js';

/**
 * Install plugins from a repository or a local directory.
 *
 *   npx tsx tools/plugins/Install.ts https://github.com/<owner>/<plugin-repo>
 *   npx tsx tools/plugins/Install.ts ../04SecondAge --plugin dragon_scimitar
 *
 * Plugins are **copied**, never symlinked: the packer's directory walk uses `entry.isDirectory()`,
 * which is lstat-based, so a symlinked plugin directory is silently skipped and the plugin simply
 * does not exist - with no error anywhere.
 *
 * Models are not expected in the repository. A plugin declares where its assets come from and
 * they are imported from this server's own content checkout, so nothing extracted is
 * redistributed.
 */
function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
}

const source = process.argv[2];

if (!source || source.startsWith('--')) {
    console.error('usage: Install.ts <git-url|path> [--plugin <name>] [--no-assets]');
    process.exit(1);
}

let root = source;
let temp: string | null = null;

if (/^(https?:|git@)/.test(source)) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
    console.log(`cloning ${source}`);
    execFileSync('git', ['clone', '--depth', '1', '--quiet', source, temp], { stdio: 'inherit' });
    root = temp;
}

/** A plugin is any directory holding a plugin.json, whether nested under plugins/ or not. */
function discover(dir: string): string[] {
    const found: string[] = [];

    if (fs.existsSync(path.join(dir, 'plugin.json'))) {
        found.push(dir);
    }

    for (const sub of ['plugins', '.']) {
        const base = path.join(dir, sub);
        if (!fs.existsSync(base)) {
            continue;
        }

        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory() && fs.existsSync(path.join(base, entry.name, 'plugin.json'))) {
                found.push(path.join(base, entry.name));
            }
        }
    }

    return Array.from(new Set(found));
}

const only = arg('plugin');
const candidates = discover(root).filter(dir => !only || path.basename(dir) === only);

if (candidates.length === 0) {
    console.error(`no plugin.json found under ${root}`);
    process.exit(1);
}

let installed = 0;

for (const dir of candidates) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as Manifest;
    const name = manifest.name;

    if (name !== path.basename(dir)) {
        console.error(`skipping ${dir}: plugin.json says "${name}" but the directory is "${path.basename(dir)}"`);
        continue;
    }

    if (manifest.revision !== Environment.engine.revision) {
        // ids are per-revision, so this would half-work rather than fail
        console.error(`skipping ${name}: built for revision ${manifest.revision}, this server is ${Environment.engine.revision}`);
        continue;
    }

    const target = path.join(pluginsRoot(), name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(dir, target, { recursive: true });
    console.log(`installed ${name} ${manifest.version}`);
    installed++;

    if (process.argv.includes('--no-assets')) {
        continue;
    }

    for (const asset of manifest.assets ?? []) {
        try {
            reportImport(importModel(name, asset.from, asset.model, asset.as));
        } catch (err) {
            console.error(`  could not fetch ${asset.as}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

if (temp) {
    fs.rmSync(temp, { recursive: true, force: true });
}

if (installed === 0) {
    process.exit(1);
}

console.log(`\n${installed} plugin(s) installed into ${path.relative(process.cwd(), pluginsRoot())}`);
console.log(`models under ${path.relative(process.cwd(), modelsRoot())}`);
console.log('\nnext:');
console.log('  npx tsx tools/plugins/SyncPluginPacks.ts');
console.log('  npx tsx tools/plugins/VerifyPluginPacks.ts');
console.log('  npm run build');
