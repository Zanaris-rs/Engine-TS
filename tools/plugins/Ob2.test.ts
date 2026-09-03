import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';

import Environment from '#/util/Environment.js';
import { readOb2 } from '#tools/plugins/Ob2.js';

/**
 * The reader hand-parses a binary format from its 18-byte trailer, and an earlier attempt at the
 * stream order summed to the right total on one model while attributing the wrong bytes to the
 * wrong streams. The only convincing check is the whole corpus: if the layout is wrong, some
 * model somewhere will not add up.
 */
function everyModel(): string[] {
    const root = path.resolve(`${Environment.build.srcDir}/models`);
    const out: string[] = [];

    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ob2')) {
                out.push(full);
            }
        }
    };

    if (fs.existsSync(root)) {
        walk(root);
    }
    return out;
}

describe('ob2 reader', () => {
    it('parses every model in the content tree', () => {
        const models = everyModel();

        if (models.length === 0) {
            return; // content not checked out
        }

        assert.ok(models.length > 1000, `expected the full model corpus, found only ${models.length}`);

        const broken: string[] = [];
        for (const file of models) {
            const info = readOb2(fs.readFileSync(file));
            if (!info.wellFormed) {
                broken.push(`${path.basename(file)} (body ${info.actualLength}, header describes ${info.expectedLength})`);
            }
        }

        assert.deepStrictEqual(broken, [], `${broken.length} of ${models.length} models did not parse`);
    });

    it('reports rigging, which is what makes a cross-revision import unsafe', () => {
        const root = path.resolve(`${Environment.build.srcDir}/models`);
        const worn = path.join(root, 'human/weapons/human_weapons_scimitar.ob2');
        const inv = path.join(root, 'inv/inv_scimitar.ob2');

        if (!fs.existsSync(worn) || !fs.existsSync(inv)) {
            return;
        }

        // a worn model is animated by the player's skeleton, so it carries labels
        assert.strictEqual(readOb2(fs.readFileSync(worn)).rigged, true, 'a worn model should be detected as rigged');
        // an inventory icon never animates, which is why item icons port between revisions cleanly
        assert.strictEqual(readOb2(fs.readFileSync(inv)).rigged, false, 'an inventory icon should not be detected as rigged');
    });

    it('rejects a truncated model rather than guessing', () => {
        const models = everyModel();
        if (models.length === 0) {
            return;
        }

        const good = fs.readFileSync(models[0]);
        const truncated = good.subarray(0, good.length - 4);
        assert.strictEqual(readOb2(truncated).wellFormed, false);
        assert.strictEqual(readOb2(Buffer.alloc(4)).wellFormed, false);
    });
});
