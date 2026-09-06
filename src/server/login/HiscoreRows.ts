import { PlayerStatEnabled } from '#/engine/entity/PlayerStat.js';

export interface HiscoreRow {
    type: number;
    level: number;
    value: number;
}

export interface HiscoreRows {
    /** hiscore_large, type 0: total level and total XP across the enabled stats. */
    overall: HiscoreRow;
    /** hiscore, type = PlayerStat index + 1. Only stats at base level 15 or above. */
    skills: HiscoreRow[];
}

/**
 * Kept in its own module (and free of any database import) so the ranking rules
 * can be unit tested without opening a connection.
 *
 * `value` is raw XP as the engine stores it, i.e. XP x 10.
 */
export function buildHiscoreRows(stats: ArrayLike<number>, baseLevels: ArrayLike<number>): HiscoreRows {
    let totalXp = 0;
    let totalLevel = 0;
    const skills: HiscoreRow[] = [];

    for (let stat = 0; stat < stats.length; stat++) {
        if (!PlayerStatEnabled[stat]) {
            continue;
        }

        totalXp += stats[stat];
        totalLevel += baseLevels[stat];

        if (baseLevels[stat] >= 15) {
            skills.push({
                type: stat + 1,
                level: baseLevels[stat],
                value: stats[stat]
            });
        }
    }

    return {
        overall: { type: 0, level: totalLevel, value: totalXp },
        skills
    };
}
