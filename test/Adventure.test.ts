import assert from 'node:assert/strict';
import test from 'node:test';

import { levelUpLines } from '#/engine/entity/LevelUpLines.js';
import { ADVENTURE_BUFFER_MAX, ADVENTURE_EVENT_MAX } from '#/engine/entity/tracking/AdventureEvent.js';
import { AdventureCategory, classifyAdventure, lookOf, parseAdventureBatch } from '#/server/login/Adventure.js';

// Every ADVENTURE line the engine and content write, as they come out. The
// engine's are in LevelUpLines.ts; content's are the `session_log(^log_adventure,
// ...)` calls, with each `<...>` filled in (quests are one shape, 80 calls).
// A new kind of line reads as OTHER until classifyAdventure learns it.
const LINES: [string, AdventureCategory][] = [
    ['Levelled up woodcutting from 40 to 41', AdventureCategory.LEVEL],
    ['Levelled up hitpoints from 9 to 12', AdventureCategory.LEVEL],
    ['Reached total level 500', AdventureCategory.MILESTONE],
    ['Reached total level 1881 - you beat p2p!', AdventureCategory.MILESTONE],
    ['Reached total level 1485 - you beat f2p!', AdventureCategory.MILESTONE],
    ['Quest complete: Rune Mysteries', AdventureCategory.QUEST],
    ['Quest complete: Romeo & Juliet', AdventureCategory.QUEST],
    ['Quest complete: Shield of Arrav (Phoenix Gang)', AdventureCategory.QUEST],
    // shared_droptables.rs2
    ['Defeated a Greater demon and received a Rune platebody!', AdventureCategory.DROP],
    // trail_clue_{easy,medium,hard}_reward.rs2
    ['Completed an Easy Clue Scroll and received 1 Rare Reward(s)!', AdventureCategory.CLUE],
    ['Completed an Easy Clue Scroll.', AdventureCategory.CLUE],
    ['Completed a Medium Clue Scroll and received 2 Rare Reward(s)!', AdventureCategory.CLUE],
    ['Completed a Medium Clue Scroll.', AdventureCategory.CLUE],
    ['Completed a Hard Clue Scroll and received 1 Rare Reward(s)!', AdventureCategory.CLUE],
    ['Completed a Hard Clue Scroll.', AdventureCategory.CLUE],
    // macro events
    ['Failed random event and got teleported', AdventureCategory.RANDOM],
    ['Lost their Big fishing net in a whirlpool', AdventureCategory.RANDOM],
    ['Lost their Rune pickaxe head', AdventureCategory.RANDOM],
    ['Broke their Rune pickaxe', AdventureCategory.RANDOM],
    ['Broke their Rune axe', AdventureCategory.RANDOM],
    ['Lost their Rune axe head', AdventureCategory.RANDOM],
    // tutorial.rs2
    ['Completed tutorial island', AdventureCategory.TUTORIAL]
];

test('every line the game writes has its category', () => {
    for (const [line, category] of LINES) {
        assert.equal(classifyAdventure(line), category, line);
    }
});

test('anything else is OTHER, not a guess', () => {
    for (const line of ['Levelled', 'Quest complete', 'Completed a Legendary Clue Scroll.', 'Defeated a goblin', 'hello']) {
        assert.equal(classifyAdventure(line), AdventureCategory.OTHER, line);
    }
});

test('the categories are the numbers the table checks', () => {
    const values = Object.values(AdventureCategory).sort((a, b) => a - b);
    assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7]);
});

const SKILLS = 21;

/** Base levels with every enabled skill at `level` and the two unused stats at 1. */
function levels(level: number, overrides: Record<number, number> = {}): number[] {
    const out = new Array(SKILLS).fill(level);
    out[18] = 1;
    out[19] = 1;
    for (const [stat, value] of Object.entries(overrides)) {
        out[Number(stat)] = value;
    }
    return out;
}

// Stats (PlayerStat): 0 attack, 9 fletching (members), 20 runecraft (free).
test('a level-up writes its line, and a milestone when one is crossed', () => {
    assert.deepEqual(levelUpLines(0, 40, levels(1, { 0: 41 })), ['Levelled up attack from 40 to 41']);

    // nineteen enabled skills: eighteen at 13 and attack at 16 is 250 exactly
    const at250 = levels(13, { 0: 16 });
    assert.equal(
        at250.reduce((sum, value, stat) => (stat === 18 || stat === 19 ? sum : sum + value), 0),
        250
    );
    assert.deepEqual(levelUpLines(0, 15, at250), ['Levelled up attack from 15 to 16', 'Reached total level 250']);
});

test('the f2p line is written once, when a free skill takes the free total to 1485', () => {
    // every free skill at 99, members skills at 1, runecraft just reaching 99
    const free = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 20];
    const maxedFree = levels(1);
    for (const stat of free) maxedFree[stat] = 99;

    assert.ok(levelUpLines(20, 98, maxedFree).includes('Reached total level 1485 - you beat f2p!'));

    // the regression: a members level afterwards leaves the free total at 1485
    const laterMembers = [...maxedFree];
    laterMembers[9] = 2;
    assert.ok(!levelUpLines(9, 1, laterMembers).includes('Reached total level 1485 - you beat f2p!'));
});

test('the p2p line is written at 1881', () => {
    assert.ok(levelUpLines(9, 98, levels(99)).includes('Reached total level 1881 - you beat p2p!'));
});

test('a save batch is taken as it was built', () => {
    const batch = { session: 'abc', events: [{ seq: 0, timestamp: 1700000000000, event: 'Levelled up attack from 1 to 2' }] };
    assert.deepEqual(parseAdventureBatch(batch), batch);
});

test('a line is cut to the length the table takes', () => {
    const parsed = parseAdventureBatch({ session: 'abc', events: [{ seq: 0, timestamp: 1, event: 'x'.repeat(300) }] });
    assert.equal(parsed?.events[0].event.length, ADVENTURE_EVENT_MAX);
});

test('anything that is not a batch is refused whole', () => {
    const line = { seq: 0, timestamp: 1, event: 'Levelled up attack from 1 to 2' };
    for (const bad of [
        undefined,
        null,
        'abc',
        { session: '', events: [] },
        { session: 'headless', events: [line] },
        { session: 'x'.repeat(65), events: [line] },
        { session: 'abc', events: 'no' },
        { session: 'abc', events: new Array(ADVENTURE_BUFFER_MAX + 1).fill(line) },
        { session: 'abc', events: [{ ...line, seq: -1 }] },
        { session: 'abc', events: [{ ...line, seq: 1.5 }] },
        { session: 'abc', events: [{ ...line, timestamp: 'now' }] },
        { session: 'abc', events: [{ ...line, event: '' }] },
        { session: 'abc', events: [null] }
    ]) {
        assert.equal(parseAdventureBatch(bad), null, JSON.stringify(bad)?.slice(0, 80));
    }
});

test('a look is the save body, colours and all fourteen worn slots', () => {
    const worn = new Map([
        [0, { id: 1163 }],
        [4, { id: 1127 }]
    ]);
    const look = lookOf([0, 10, 18, 26, 33, 36, 42], [1, 2, 3, 4, 5], 0, { get: (slot: number) => worn.get(slot) ?? null });
    assert.deepEqual(look, {
        gender: 0,
        kits: [0, 10, 18, 26, 33, 36, 42],
        colours: [1, 2, 3, 4, 5],
        worn: [1163, -1, -1, -1, 1127, -1, -1, -1, -1, -1, -1, -1, -1, -1]
    });

    assert.deepEqual(lookOf([45, -1, 56, 61, 67, 70, 79], [0, 0, 0, 0, 0], 1, null).worn, new Array(14).fill(-1));
});
