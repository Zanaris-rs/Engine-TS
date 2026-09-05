import type { Kysely } from 'kysely';

import type { DB } from '#/db/types.js';
import { toDisplayName } from '#/util/JString.js';

/**
 * The Message Centre, as far as the login server is concerned: the unread
 * count that goes on the client's welcome screen, and the notices a ban or a
 * mute leaves behind.
 *
 * The unread rule is one line, and it is a contract shared with the website
 * and with `accounts.unread()` in migration `3_message_centre`:
 *
 *     count(*) from account_message where account_id = $1 and read_at is null
 *
 * It is pinned in `test/fixtures/message-centre-contract.json` and copied into
 * the website's own fixture, because the failure mode if the two sides drift
 * is a number in game that the site cannot explain - and nothing anywhere
 * throws.
 */

/** The five values `account_message.kind` is allowed to take. */
export const MESSAGE_KINDS = ['welcome', 'notice', 'ban', 'mute', 'reply'] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * LAST_LOGIN_INFO writes the count with `p2`, so anything above 65535 wraps
 * and a player with 70,000 unread messages would be told they have 4,464.
 */
export const MAX_MESSAGE_COUNT = 65535;

/** A second ban inside this window reuses the first notice rather than adding one. */
export const NOTICE_DUPLICATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Into the range `p2` can actually carry. Anything that is not a real number -
 * a NaN out of a driver that handed back a string, an undefined out of an
 * empty result - is 0, which is what the welcome screen shows when there is
 * nothing to say.
 */
export function clampMessageCount(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.min(Math.floor(value), MAX_MESSAGE_COUNT);
}

/**
 * The contract query itself, as a builder so a test can compile it without a
 * database. Kysely writes it as
 *
 *     select count(*) as "unread" from "account_message"
 *      where "account_id" = $1 and "read_at" is null
 *
 * on postgres and the same with `?` on sqlite.
 */
export function unreadQuery(database: Kysely<DB>, accountId: number) {
    return database
        .selectFrom('account_message')
        .select(eb => eb.fn.countAll().as('unread'))
        .where('account_id', '=', accountId)
        .where('read_at', 'is', null);
}

/**
 * postgres hands `count(*)` back as a bigint, which `pg` would give us as a
 * string were the type parser in query.ts not installed; sqlite gives a
 * number. `Number(...)` reads either, and the clamp turns anything else into
 * the honest 0.
 */
export async function countUnread(database: Kysely<DB>, accountId: number): Promise<number> {
    const row = await unreadQuery(database, accountId).executeTakeFirst();

    return clampMessageCount(Number(row?.unread ?? 0));
}

/**
 * Has this account already been told? A ban is often followed by a longer ban
 * seconds later, and three notices for one moderation decision is noise.
 *
 * `since` goes in as a Date and every backend takes it: the sqlite driver
 * formats it as the same UTC `YYYY-MM-DD HH:MM:SS` string `CURRENT_TIMESTAMP`
 * writes, and pg and mysql2 bind it natively.
 */
export function recentNoticeQuery(database: Kysely<DB>, accountId: number, kind: MessageKind, since: Date) {
    return database.selectFrom('account_message').select('id').where('account_id', '=', accountId).where('kind', '=', kind).where('read_at', 'is', null).where('created_at', '>', since);
}

/** `2026-09-06 14:32 UTC` - short enough for a subject line, unambiguous anywhere. */
export function formatUntil(until: Date): string {
    return `${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * `::ban` and `::mute` pass the moderator's own username; the automated paths
 * (report abuse with a bad reason, private-message spam) pass 'automated'.
 * Neither carries a reason: the cheat string is lowercased and capped at 80
 * characters before it reaches the handler, so there is nowhere to put one.
 */
export function noticeActor(staff: string): string {
    return staff === 'automated' ? 'an automated check' : toDisplayName(staff);
}

export type ModerationNotice = { kind: MessageKind; subject: string; body: string };

export function banNotice(staff: string, until: Date): ModerationNotice {
    return {
        kind: 'ban',
        subject: `Your account has been banned until ${formatUntil(until)}`,
        body: `Your account has been banned by ${noticeActor(staff)} and cannot log in to the game until ${formatUntil(until)}.

You can still sign in to the website with the same username and password, which is where you are reading this.

If you believe this is a mistake, open a ticket in the Message Centre, choose "appeal", and say what you were doing at the time. A moderator will read it and reply to you here.`
    };
}

export function muteNotice(staff: string, until: Date): ModerationNotice {
    return {
        kind: 'mute',
        subject: `You have been muted until ${formatUntil(until)}`,
        body: `You have been muted by ${noticeActor(staff)}. You can still play, but nobody else will see what you say in public chat until ${formatUntil(until)}.

If you believe this is a mistake, open a ticket in the Message Centre, choose "appeal", and say what you were doing at the time. A moderator will read it and reply to you here.`
    };
}
