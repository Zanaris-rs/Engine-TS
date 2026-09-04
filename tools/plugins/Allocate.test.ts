import assert from 'assert';
import { describe, it } from 'node:test';

import { PLUGIN_ID_BASE } from '#tools/plugins/PluginIds.js';
import { Lock, RawEntry, resolve } from '#tools/plugins/PluginPacks.js';

const empty: Lock = { version: 1, assigned: {}, tombstoned: {} };

function raw(type: RawEntry['type'], id: number | 'auto', name: string, plugin = 'p'): RawEntry {
    return { type, id, name, plugin, file: 'plugin.pack', line: 1 };
}

describe('symbolic id allocation', () => {
    it('assigns from the reserved base and records it', () => {
        const { entries, lock, changed } = resolve([raw('obj', 'auto', 'sword')], empty);

        assert.strictEqual(entries[0].id, PLUGIN_ID_BASE.obj);
        assert.strictEqual(lock.assigned.obj?.sword, PLUGIN_ID_BASE.obj);
        assert.strictEqual(changed, true);
    });

    it('keeps an id once assigned, so saves stay valid', () => {
        const first = resolve([raw('obj', 'auto', 'sword')], empty);
        // a second plugin arrives and would otherwise take the same id
        const second = resolve([raw('obj', 'auto', 'shield'), raw('obj', 'auto', 'sword')], first.lock);

        const byName = Object.fromEntries(second.entries.map(e => [e.name, e.id]));
        assert.strictEqual(byName.sword, PLUGIN_ID_BASE.obj, 'an existing symbol moved');
        assert.notStrictEqual(byName.shield, byName.sword, 'two symbols were given the same id');
    });

    it('never hands out an id a fixed declaration already uses', () => {
        const fixed = PLUGIN_ID_BASE.obj;
        const { entries } = resolve([raw('obj', fixed, 'pinned'), raw('obj', 'auto', 'floating')], empty);

        const byName = Object.fromEntries(entries.map(e => [e.name, e.id]));
        assert.strictEqual(byName.pinned, fixed);
        assert.notStrictEqual(byName.floating, fixed);
    });

    it('tombstones a removed symbol instead of freeing its id', () => {
        const before = resolve([raw('obj', 'auto', 'gone'), raw('obj', 'auto', 'stays')], empty);
        const goneId = before.lock.assigned.obj!.gone;

        const after = resolve([raw('obj', 'auto', 'stays')], before.lock);

        assert.strictEqual(after.lock.assigned.obj?.gone, undefined, 'the removed symbol is still assigned');
        assert.strictEqual(after.lock.tombstoned.obj?.gone, goneId, 'the removed id was not tombstoned');

        // and a newcomer must not inherit it - that would alias a deleted item onto a new one
        const newcomer = resolve([raw('obj', 'auto', 'stays'), raw('obj', 'auto', 'fresh')], after.lock);
        const freshId = newcomer.entries.find(e => e.name === 'fresh')!.id;
        assert.notStrictEqual(freshId, goneId, 'a tombstoned id was reused');
    });

    it('two plugins allocating independently never collide', () => {
        const a = resolve([raw('npc', 'auto', 'boss', 'plugin_a')], empty);
        const b = resolve([raw('npc', 'auto', 'boss_b', 'plugin_b'), ...[raw('npc', 'auto', 'boss', 'plugin_a')]], a.lock);

        const ids = b.entries.map(e => e.id);
        assert.strictEqual(new Set(ids).size, ids.length, 'ids collided across plugins');
    });

    it('refuses when the range is exhausted rather than overflowing the field', () => {
        // npc is the tight one: 11 bits, so an overflow renders as a different npc silently
        const full: Lock = { version: 1, assigned: {}, tombstoned: { npc: {} } };
        for (let id = PLUGIN_ID_BASE.npc; id < 2048; id++) {
            full.tombstoned.npc![`x${id}`] = id;
        }

        assert.throws(() => resolve([raw('npc', 'auto', 'one_too_many')], full), /no npc ids left/);
    });
});
