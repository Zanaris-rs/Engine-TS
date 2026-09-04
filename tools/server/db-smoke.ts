/**
 * Exercises every shape of query the login and friend servers actually issue,
 * against whatever backend data/config/world.json selects, and then deletes
 * everything it made:
 *
 *   npm run db:smoke
 *
 * The point is the shapes, not the coverage: batched upserts, boolean and date
 * binding, ON CONFLICT DO NOTHING, and count(*) all differ between sqlite,
 * mysql and postgres, and each one has silently done the wrong thing at some
 * point in this codebase.
 */
import { fromDbDate } from '#/db/DateFormat.js';
import { db, toDbDate } from '#/db/query.js';
import type Player from '#/engine/entity/Player.js';
import { updateHiscores } from '#/server/login/Hiscores.js';
import Environment from '#/util/Environment.js';

const profile = 'db-smoke';
const username = `smoke_${Date.now().toString(36).slice(-6)}`;

let failures = 0;

function check(what: string, ok: boolean, detail?: unknown) {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);

    if (!ok) {
        failures++;
    }
}

/** updateHiscores only reads these two, so a whole Player is not needed. */
function fakePlayer(attackXp: number): Player {
    const stats = new Int32Array(21);
    const baseLevels = new Uint8Array(21);

    stats[0] = attackXp;
    baseLevels[0] = 40;
    stats[3] = 11540;
    baseLevels[3] = 28;

    return { stats, baseLevels } as Player;
}

async function main() {
    console.log(`Using the ${Environment.db.backend} backend, profile '${profile}', username '${username}'.`);

    const bannedUntil = new Date('2030-01-02T03:04:05.000Z');

    await db
        .insertInto('account')
        .values({
            username,
            password: 'not-a-real-hash',
            email: `${username}@example.com`,
            email_normalized: `${username}@example.com`,
            registration_ip: '203.0.113.7',
            registration_group: '203.0.113.0/24',
            registration_date: toDbDate(new Date()),
            banned_until: toDbDate(bannedUntil)
        })
        .executeTakeFirstOrThrow();

    const account = await db.selectFrom('account').selectAll().where('username', '=', username).executeTakeFirstOrThrow();
    check('insert then re-select by username', account.username === username, { id: account.id });

    check('members defaults to false', !account.members, { members: account.members });

    await db.updateTable('account').set({ members: true }).where('id', '=', account.id).execute();
    const membered = await db.selectFrom('account').select('members').where('id', '=', account.id).executeTakeFirstOrThrow();
    check('members flips to true', Boolean(membered.members), { members: membered.members });

    check('banned_until reads back as the UTC instant it was written', fromDbDate(account.banned_until!).getTime() === bannedUntil.getTime(), {
        stored: String(account.banned_until),
        parsed: fromDbDate(account.banned_until!).toISOString()
    });

    // hiscores: the second pass changes nothing, so `date` must not move
    const hiscoreAccount = { id: account.id, staffmodlevel: 0, banned_until: null };

    await updateHiscores(hiscoreAccount, fakePlayer(377_000), profile);
    const first = await db.selectFrom('hiscore').selectAll().where('account_id', '=', account.id).where('profile', '=', profile).orderBy('type').execute();
    const firstLarge = await db.selectFrom('hiscore_large').selectAll().where('account_id', '=', account.id).where('profile', '=', profile).executeTakeFirstOrThrow();
    check(
        'one skill row per stat at level 15 or above',
        first.length === 2 && first.map(row => row.type).join(',') === '1,4',
        first.map(row => ({ type: row.type, level: row.level, value: row.value }))
    );
    check('the overall row is written to hiscore_large', firstLarge.type === 0 && firstLarge.value === 388_540, { level: firstLarge.level, value: firstLarge.value });

    await new Promise(resolve => setTimeout(resolve, 1100));

    await updateHiscores(hiscoreAccount, fakePlayer(377_000), profile);
    const unchanged = await db.selectFrom('hiscore').selectAll().where('account_id', '=', account.id).where('profile', '=', profile).where('type', '=', 1).executeTakeFirstOrThrow();
    check('re-upserting the same XP leaves date alone', String(unchanged.date) === String(first[0].date), { before: String(first[0].date), after: String(unchanged.date) });

    await updateHiscores(hiscoreAccount, fakePlayer(400_000), profile);
    const moved = await db.selectFrom('hiscore').selectAll().where('account_id', '=', account.id).where('profile', '=', profile).where('type', '=', 1).executeTakeFirstOrThrow();
    check('upserting new XP updates value and moves date', moved.value === 400_000 && String(moved.date) !== String(first[0].date), { value: moved.value, date: String(moved.date) });

    // ignorelist: the second insert must be a no-op, not an error
    for (let i = 0; i < 2; i++) {
        let query = db.insertInto('ignorelist').values({ account_id: account.id, profile, value: 'someone' });

        if (Environment.db.backend === 'sqlite' || Environment.db.backend === 'postgres') {
            query = query.onConflict(oc => oc.doNothing());
        } else {
            query = query.onDuplicateKeyUpdate({ value: 'someone' });
        }

        await query.execute();
    }

    const ignores = await db
        .selectFrom('ignorelist')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('account_id', '=', account.id)
        .executeTakeFirstOrThrow();
    check('adding the same ignore twice leaves one row', Number(ignores.count) === 1, { count: ignores.count, type: typeof ignores.count });

    const friends = await db
        .selectFrom('friendlist')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('account_id', '=', account.id)
        .executeTakeFirstOrThrow();
    check('count(*) comes back as a number', Number.isFinite(Number(friends.count)) && Number(friends.count) === 0, { count: friends.count, type: typeof friends.count });

    await db.deleteFrom('ignorelist').where('account_id', '=', account.id).execute();
    await db.deleteFrom('hiscore').where('account_id', '=', account.id).where('profile', '=', profile).execute();
    await db.deleteFrom('hiscore_large').where('account_id', '=', account.id).where('profile', '=', profile).execute();
    await db.deleteFrom('account').where('id', '=', account.id).execute();

    const gone = await db.selectFrom('account').select('id').where('username', '=', username).executeTakeFirst();
    check('the throwaway account is deleted', !gone);
}

try {
    await main();
} finally {
    await db.destroy();
}

if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
}

console.log('All checks passed.');
