import { PlayerStatEnabled, PlayerStatFree, PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';

/** Total levels are marked every this many (should be >= 100). */
export const TOTAL_LEVEL_MILESTONE = 250;

/**
 * The Adventurer Log lines a level-up writes (`Player.addXp`): the level
 * itself, a total-level milestone when one was crossed, and the two totals
 * that mean a player has maxed - 1881 with every skill at 99, and 1485 with
 * every free-to-play skill at 99.
 *
 * `baseLevels` is after the level-up. The f2p line needs the levelled skill to
 * be a free one: 1485 is the free skills' maximum, so a free total of 1485 is
 * still 1485 at every members level after it, and used to write the line
 * again each time.
 */
export function levelUpLines(stat: number, before: number, baseLevels: ArrayLike<number>): string[] {
    const after = baseLevels[stat];
    const lines = ['Levelled up ' + PlayerStatNameMap.get(stat)?.toLowerCase() + ' from ' + before + ' to ' + after];

    let total = 0;
    let freeTotal = 0;
    for (let other = 0; other < baseLevels.length; other++) {
        if (!PlayerStatEnabled[other]) {
            continue;
        }

        total += baseLevels[other];

        if (PlayerStatFree[other]) {
            freeTotal += baseLevels[other];
        }
    }

    const prevMilestone = ((total - (after - before)) / TOTAL_LEVEL_MILESTONE) | 0;
    const currMilestone = (total / TOTAL_LEVEL_MILESTONE) | 0;
    if (currMilestone > prevMilestone) {
        lines.push(`Reached total level ${currMilestone * TOTAL_LEVEL_MILESTONE}`);
    }
    if (total === 1881) {
        lines.push('Reached total level 1881 - you beat p2p!');
    }
    if (PlayerStatFree[stat] && freeTotal === 1485) {
        lines.push('Reached total level 1485 - you beat f2p!');
    }

    return lines;
}
