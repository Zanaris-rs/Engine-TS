import type { Selectable } from 'kysely';

import { fromDbDate } from '#/db/DateFormat.js';
import { db, toDbDate } from '#/db/query.js';
import type { account } from '#/db/types.js';
import type Player from '#/engine/entity/Player.js';
import Environment from '#/util/Environment.js';

import { buildHiscoreRows, type HiscoreRow } from '#/server/login/HiscoreRows.js';

export { buildHiscoreRows } from '#/server/login/HiscoreRows.js';

// postgres hands back a Date, sqlite the 'YYYY-MM-DD HH:MM:SS' string it stored;
// the generated types only know about the former.
export type HiscoreAccount = Pick<Selectable<account>, 'id' | 'staffmodlevel'> & {
    banned_until: Date | string | null;
};

type HiscoreTable = 'hiscore' | 'hiscore_large';

/**
 * One statement per table instead of a select-then-write per skill: a logout used
 * to cost ~40 sequential round trips, which is free against a local sqlite file
 * and not free at all against a database in another datacentre.
 *
 * The `whereRef` guard is what keeps `date` meaningful - it only moves when the
 * XP actually changed, and the hiscore ordering breaks ties on the oldest date.
 */
async function upsertRows(table: HiscoreTable, accountId: number, profile: string, rows: HiscoreRow[], date: string) {
    if (rows.length === 0) {
        return;
    }

    const values = rows.map(row => ({
        account_id: accountId,
        profile,
        type: row.type,
        level: row.level,
        value: row.value,
        date
    }));

    if (Environment.db.backend === 'mysql') {
        // mysql has no "update only when the row changed" form of upsert, so it
        // keeps the read-then-write loop it has always used.
        for (const row of values) {
            const existing = await db.selectFrom(table).select('value').where('account_id', '=', row.account_id).where('type', '=', row.type).where('profile', '=', row.profile).executeTakeFirst();

            if (!existing) {
                await db.insertInto(table).values(row).execute();
            } else if (existing.value !== row.value) {
                await db.updateTable(table).set({ level: row.level, value: row.value, date: row.date }).where('account_id', '=', row.account_id).where('type', '=', row.type).where('profile', '=', row.profile).execute();
            }
        }

        return;
    }

    await db
        .insertInto(table)
        .values(values)
        .onConflict(oc =>
            oc
                .columns(['profile', 'type', 'account_id'])
                .doUpdateSet(eb => ({
                    level: eb.ref('excluded.level'),
                    value: eb.ref('excluded.value'),
                    date: eb.ref('excluded.date')
                }))
                .whereRef(`${table}.value`, '<>', 'excluded.value')
        )
        .execute();
}

export async function updateHiscores(account: HiscoreAccount | undefined, player: Player, profile: string) {
    if (!account) {
        return;
    }

    if (account.staffmodlevel > 1) {
        return;
    }

    if (account.banned_until !== null && fromDbDate(account.banned_until) >= new Date()) {
        return;
    }

    const rows = buildHiscoreRows(player.stats, player.baseLevels);
    const date = toDbDate(new Date());

    await upsertRows('hiscore_large', account.id, profile, [rows.overall], date);
    await upsertRows('hiscore', account.id, profile, rows.skills, date);
}
