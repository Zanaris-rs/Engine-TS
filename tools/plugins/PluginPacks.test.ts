import assert from 'assert';
import { describe, it } from 'node:test';

import { parseFragment } from '#tools/plugins/PluginPacks.js';

const where = 'plugin.pack';

describe('plugin.pack fragments', () => {
    it('reads entries and records where each came from', () => {
        const out = parseFragment('# a comment\nmodel 20000 plugin_thing\nobj   20000 thing\n', 'thing', where);

        assert.strictEqual(out.length, 2);
        assert.deepStrictEqual(
            out.map(e => [e.type, e.id, e.name]),
            [
                ['model', 20000, 'plugin_thing'],
                ['obj', 20000, 'thing']
            ]
        );
        // line numbers are what make a bad fragment diagnosable
        assert.deepStrictEqual(
            out.map(e => e.line),
            [2, 3]
        );
        assert.strictEqual(out[0].plugin, 'thing');
    });

    it('ignores blank lines, comments, and trailing comments', () => {
        assert.deepStrictEqual(parseFragment('\n\n# just a comment\n', 'p', where), []);
        assert.strictEqual(parseFragment('obj 20000 thing # why\n', 'p', where).length, 1);
    });

    it('refuses an unknown pack type rather than silently dropping it', () => {
        assert.throws(() => parseFragment('sprite 20000 thing\n', 'p', where), /unknown pack type "sprite"/);
    });

    it('refuses a malformed line', () => {
        assert.throws(() => parseFragment('obj 20000\n', 'p', where), /expected "<type> <id> <name>"/);
        assert.throws(() => parseFragment('obj twenty thing\n', 'p', where), /not a valid id/);
        assert.throws(() => parseFragment('obj -5 thing\n', 'p', where), /not a valid id/);
    });

    it('points at the offending line', () => {
        assert.throws(() => parseFragment('obj 20000 ok\n\nnope 1 x\n', 'p', where), /plugin\.pack:3/);
    });
});
