import assert from 'node:assert/strict';
import test from 'node:test';

import { PlayerStat, PlayerStatEnabled } from '#/engine/entity/PlayerStat.js';
import { buildHiscoreRows } from '#/server/login/HiscoreRows.js';

function blank(): { stats: number[]; baseLevels: number[] } {
    return { stats: new Array(21).fill(0), baseLevels: new Array(21).fill(1) };
}

test('overall totals only the enabled stats', () => {
    const { stats, baseLevels } = blank();
    stats[PlayerStat.ATTACK] = 1000;
    baseLevels[PlayerStat.ATTACK] = 9;
    stats[PlayerStat.STAT18] = 999999; // disabled
    baseLevels[PlayerStat.STAT18] = 99;

    const rows = buildHiscoreRows(stats, baseLevels);

    // 19 enabled stats: 18 still at level 1, plus attack at 9
    assert.equal(rows.overall.type, 0);
    assert.equal(rows.overall.value, 1000);
    assert.equal(rows.overall.level, 18 + 9);
});

test('a skill row appears only at base level 15', () => {
    const { stats, baseLevels } = blank();
    baseLevels[PlayerStat.COOKING] = 14;
    stats[PlayerStat.COOKING] = 25000;

    assert.deepEqual(buildHiscoreRows(stats, baseLevels).skills, []);

    baseLevels[PlayerStat.COOKING] = 15;
    assert.deepEqual(buildHiscoreRows(stats, baseLevels).skills, [{ type: PlayerStat.COOKING + 1, level: 15, value: 25000 }]);
});

test('skill rows are typed as the stat index plus one', () => {
    const { stats, baseLevels } = blank();
    baseLevels[PlayerStat.ATTACK] = 40;
    stats[PlayerStat.ATTACK] = 377000;
    baseLevels[PlayerStat.RUNECRAFT] = 50;
    stats[PlayerStat.RUNECRAFT] = 1013000;

    const rows = buildHiscoreRows(stats, baseLevels);

    assert.deepEqual(
        rows.skills.map(row => row.type),
        [1, 21]
    );
});

test('disabled stats never produce a row, however high', () => {
    const { stats, baseLevels } = blank();
    baseLevels[PlayerStat.STAT18] = 99;
    stats[PlayerStat.STAT18] = 13034431;
    baseLevels[PlayerStat.STAT19] = 99;
    stats[PlayerStat.STAT19] = 13034431;

    const rows = buildHiscoreRows(stats, baseLevels);

    assert.deepEqual(rows.skills, []);
    assert.equal(rows.overall.value, 0);
    assert.equal(PlayerStatEnabled.filter(Boolean).length, 19);
});

test('an empty account still gets an overall row', () => {
    const { stats, baseLevels } = blank();

    const rows = buildHiscoreRows(stats, baseLevels);

    assert.equal(rows.overall.level, 19);
    assert.equal(rows.overall.value, 0);
});
