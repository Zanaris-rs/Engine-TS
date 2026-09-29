import type { Selectable } from 'kysely';

import { fromDbDate } from '#/db/DateFormat.js';
import { db, toDbDate } from '#/db/query.js';
import type { account } from '#/db/types.js';
import { ADVENTURE_BUFFER_MAX, ADVENTURE_EVENT_MAX, type AdventureBatch, type AdventureEvent } from '#/engine/entity/tracking/AdventureEvent.js';
import Environment from '#/util/Environment.js';

/**
 * The login server's half of the Adventurer Log (migration 011): the lines a
 * save brought with it go into `adventure_event`, and the body and worn items
 * the save holds go into `account_look`.
 *
 * Only ever called once the save itself has been written - a world that
 * crashes rolls its players back to their last save, and the log must not
 * keep a level or a drop the save lost.
 */

export const AdventureCategory = {
    OTHER: 0,
    LEVEL: 1,
    MILESTONE: 2,
    QUEST: 3,
    DROP: 4,
    CLUE: 5,
    RANDOM: 6,
    TUTORIAL: 7
} as const;

export type AdventureCategory = (typeof AdventureCategory)[keyof typeof AdventureCategory];

/**
 * What kind of line this is, from its wording. Every ADVENTURE line in the
 * engine and content is one of these shapes (`test/Adventure.test.ts` holds
 * them all); anything new reads as OTHER until it is added here, and since
 * the text is stored as written, older rows can be recategorised with an
 * UPDATE.
 */
export function classifyAdventure(event: string): AdventureCategory {
    if (event.startsWith('Levelled up ')) {
        return AdventureCategory.LEVEL;
    }
    if (event.startsWith('Reached total level ')) {
        return AdventureCategory.MILESTONE;
    }
    if (event.startsWith('Quest complete: ')) {
        return AdventureCategory.QUEST;
    }
    if (event.startsWith('Defeated a') && event.includes(' and received ')) {
        return AdventureCategory.DROP;
    }
    if (/^Completed an? (Easy|Medium|Hard) Clue Scroll\b/.test(event)) {
        return AdventureCategory.CLUE;
    }
    if (event.startsWith('Lost their ') || event.startsWith('Broke their ') || event === 'Failed random event and got teleported') {
        return AdventureCategory.RANDOM;
    }
    if (event === 'Completed tutorial island') {
        return AdventureCategory.TUTORIAL;
    }
    return AdventureCategory.OTHER;
}

/** Lines of the chattier kinds one account may add in a day; the rest are dropped. */
const DAILY_CAP: ReadonlyMap<AdventureCategory, number> = new Map([
    [AdventureCategory.OTHER, 50],
    [AdventureCategory.RANDOM, 50]
]);

/**
 * The batch a save message carried, or null for anything that is not one.
 * The world builds these, but the login server takes messages from every
 * world and checks what it stores.
 */
export function parseAdventureBatch(value: unknown): AdventureBatch | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    const { session, events } = value as Record<string, unknown>;
    if (typeof session !== 'string' || session.length === 0 || session.length > 64 || session === 'headless') {
        return null;
    }
    if (!Array.isArray(events) || events.length > ADVENTURE_BUFFER_MAX) {
        return null;
    }

    const out: AdventureEvent[] = [];
    for (const entry of events) {
        if (typeof entry !== 'object' || entry === null) {
            return null;
        }
        const { seq, timestamp, event } = entry as Record<string, unknown>;
        if (!Number.isSafeInteger(seq) || (seq as number) < 0) {
            return null;
        }
        if (!Number.isFinite(timestamp)) {
            return null;
        }
        if (typeof event !== 'string' || event.length === 0) {
            return null;
        }
        out.push({ seq: seq as number, timestamp: timestamp as number, event: event.slice(0, ADVENTURE_EVENT_MAX) });
    }

    return { session, events: out };
}

export type Look = {
    gender: number;
    kits: number[];
    colours: number[];
    worn: number[];
};

/** Slots in the worn inventory, the fourteen `wearpos` values. */
export const WORN_SLOTS = 14;

/**
 * A save's look, in the shape `account_look` and the website's outfits keep:
 * gender, the seven kits (-1 for none), the five colours, and the object in
 * each worn slot (-1 for empty).
 */
export function lookOf(body: ArrayLike<number>, colours: ArrayLike<number>, gender: number, worn: { get(slot: number): { id: number } | null } | null): Look {
    const slots: number[] = [];
    for (let slot = 0; slot < WORN_SLOTS; slot++) {
        slots.push(worn?.get(slot)?.id ?? -1);
    }

    return {
        gender,
        kits: Array.from(body),
        colours: Array.from(colours),
        worn: slots
    };
}

type AdventureAccount = Pick<Selectable<account>, 'id' | 'staffmodlevel'> & {
    banned_until: Date | string | null;
};

async function insertEvents(accountId: number, profile: string, batch: AdventureBatch) {
    let rows = batch.events.map(entry => ({
        account_id: accountId,
        profile,
        session_uuid: batch.session,
        seq: entry.seq,
        occurred_at: toDbDate(new Date(entry.timestamp)),
        category: classifyAdventure(entry.event),
        event: entry.event
    }));

    const capped = rows.filter(row => DAILY_CAP.has(row.category as AdventureCategory));
    if (capped.length > 0) {
        // A Date, as LoginServer's report lookup does: kysely types the
        // comparison against the column's read type, and every driver binds one.
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const counts = await db
            .selectFrom('adventure_event')
            .select(['category', eb => eb.fn.countAll<number>().as('n')])
            .where('account_id', '=', accountId)
            .where('profile', '=', profile)
            .where('occurred_at', '>=', since)
            .where('category', 'in', [...DAILY_CAP.keys()])
            .groupBy('category')
            .execute();

        const room = new Map<number, number>();
        for (const [category, cap] of DAILY_CAP) {
            const used = Number(counts.find(row => row.category === category)?.n ?? 0);
            room.set(category, Math.max(0, cap - used));
        }

        // Oldest first: what room is left goes to the batch's earliest lines.
        rows = rows.filter(row => {
            const left = room.get(row.category);
            if (left === undefined) {
                return true;
            }
            room.set(row.category, left - 1);
            return left > 0;
        });
    }

    if (rows.length === 0) {
        return;
    }

    if (Environment.db.backend === 'mysql') {
        await db.insertInto('adventure_event').ignore().values(rows).execute();
        return;
    }

    await db
        .insertInto('adventure_event')
        .values(rows)
        .onConflict(oc => oc.columns(['session_uuid', 'seq']).doNothing())
        .execute();
}

async function upsertLook(accountId: number, profile: string, look: Look) {
    const row = {
        account_id: accountId,
        profile,
        gender: look.gender,
        kits: JSON.stringify(look.kits),
        colours: JSON.stringify(look.colours),
        worn: JSON.stringify(look.worn),
        updated_at: toDbDate(new Date())
    };

    const existing = await db.selectFrom('account_look').select(['gender', 'kits', 'colours', 'worn']).where('account_id', '=', accountId).where('profile', '=', profile).executeTakeFirst();

    if (!existing) {
        await db.insertInto('account_look').values(row).execute();
    } else if (existing.gender !== row.gender || existing.kits !== row.kits || existing.colours !== row.colours || existing.worn !== row.worn) {
        // Written only when it changed, so updated_at says when the look last
        // did, and fifteen-minute autosaves of an unchanged player cost a read.
        await db.updateTable('account_look').set({ gender: row.gender, kits: row.kits, colours: row.colours, worn: row.worn, updated_at: row.updated_at }).where('account_id', '=', accountId).where('profile', '=', profile).execute();
    }
}

/**
 * Store what a save carried for the Adventurer Log. Never throws: this runs
 * after the save and the hiscores, and a failure here must not become a
 * failed logout.
 */
export async function recordAdventure(account: AdventureAccount | undefined, profile: string, look: Look, batch: unknown) {
    if (!account) {
        return;
    }

    try {
        await upsertLook(account.id, profile, look);

        // The accounts updateHiscores skips: staff commands are not adventures,
        // and a banned account's log is not being written.
        if (account.staffmodlevel > 1) {
            return;
        }
        if (account.banned_until !== null && fromDbDate(account.banned_until) >= new Date()) {
            return;
        }

        const parsed = parseAdventureBatch(batch);
        if (parsed && parsed.events.length > 0) {
            await insertEvents(account.id, profile, parsed);
        }
    } catch (err) {
        console.error('adventure log failed for account_id %s', account.id, err);
    }
}
