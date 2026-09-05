import type { Kysely } from 'kysely';

import type { DB } from '#/db/types.js';
import { toDisplayName } from '#/util/JString.js';

/**
 * The Message Centre, as far as the login server is concerned: the unread
 * count that goes on the client's welcome screen, and the notices a ban or a
 * mute leaves behind - and, since the same two messages now leave a permanent
 * record as well, the rest of the login server's record writing: `punishment`
 * and `staff_spawn`.
 *
 * Everything here is a query builder rather than a call, for one reason: the
 * engine runs on postgres, sqlite and mysql, and the only way to prove a
 * statement is dialect-neutral without three databases is to compile it
 * against two dialects and read the SQL back. `test/MessageCentre.test.ts`
 * does exactly that, and it is why nothing below says `now()`, `returning` or
 * anything else one backend spells differently.
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
 * A standalone message from a person: what the staff CLI and the website's
 * `staff_notice` both write. Named rather than indexed off MESSAGE_KINDS, so
 * reordering that list cannot quietly change what a notice is.
 */
export const NOTICE_KIND: MessageKind = 'notice';

/**
 * LAST_LOGIN_INFO writes the count with `p2`, so anything above 65535 wraps
 * and a player with 70,000 unread messages would be told they have 4,464.
 */
export const MAX_MESSAGE_COUNT = 65535;

/** A second ban inside this window rewrites the first notice rather than adding one. */
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

/**
 * The other half of that guard, and the reason it is not a plain `return`.
 * Skipping the second decision outright left the player holding the *first*
 * one's expiry: a ban extended from five minutes to a week still read "banned
 * until <five minutes from the first one>", and the moderator who extended it
 * was recorded nowhere. So the row they have not opened yet becomes the new
 * notice - subject, body, author and the time it was written - which is still
 * one message per decision, but the true one.
 *
 * `created_at` is passed in rather than written as `now()`: this compiles for
 * sqlite and postgres alike, and `toDbDate()` at the call site is what knows
 * which shape the configured backend stores.
 */
export function rewriteNoticeQuery(database: Kysely<DB>, id: number, notice: ModerationNotice, createdByAccountId: number | null, createdAt: string) {
    return database
        .updateTable('account_message')
        .set({
            subject: notice.subject,
            body: notice.body,
            created_by_account_id: createdByAccountId,
            created_at: createdAt
        })
        .where('id', '=', id);
}

/** `2026-09-06 14:32 UTC` - short enough for a subject line, unambiguous anywhere. */
export function formatUntil(until: Date): string {
    return `${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The actor `::ban` and `::mute` pass when nobody decided: report abuse with a
 * reason code outside the enum, private-message spam. It is a reserved
 * username, so there is no account row behind it - which is why the notice is
 * written with no author and the punishment row with `automated = true` and no
 * issuer.
 */
export const AUTOMATED_ACTOR = 'automated';

export function isAutomatedActor(staff: string): boolean {
    return staff === AUTOMATED_ACTOR;
}

/**
 * `::ban` and `::mute` pass the moderator's own username; the automated paths
 * (report abuse with a bad reason, private-message spam) pass 'automated'.
 * Neither carries a reason: the cheat string is lowercased and capped at 80
 * characters before it reaches the handler, so there is nowhere to put one.
 */
export function noticeActor(staff: string): string {
    return isAutomatedActor(staff) ? 'an automated check' : toDisplayName(staff);
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

/**
 * The permanent record, which is a different thing from the notice above.
 *
 * A notice is a message to one player and it can be rewritten - a ban extended
 * inside the hour overwrites the unread row rather than adding a second one.
 * A punishment row is never rewritten and never deleted: every ban and every
 * mute leaves one, and `/bans` reads them back through `public_punishments`.
 * That is why the same decision can leave one notice and two rows, and why
 * lifting a ban sets `lifted_at` instead of removing anything.
 *
 * The two `kind` values are the only ones the public page knows how to render.
 */
export const PUNISHMENT_KINDS = ['ban', 'mute'] as const;

export type PunishmentKind = (typeof PUNISHMENT_KINDS)[number];

export type PunishmentRecord = {
    accountId: number;
    username: string;
    kind: PunishmentKind;
    /** Through `toDbDate` at the call site, which is what knows the backend. */
    issuedAt: string;
    /** Null is permanent. Nothing in the engine issues one; the SQL API can. */
    until: string | null;
    automated: boolean;
    /** Null when automated, and null when the moderator has no account row. */
    issuedByAccountId: number | null;
};

/**
 * `note` and `lifted_at` are written as the nulls they are rather than left to
 * a column default: this is the row the public page reads, and "no note, not
 * lifted" is a statement about the punishment, not an absence of one.
 */
export function punishmentInsertQuery(database: Kysely<DB>, record: PunishmentRecord) {
    return database.insertInto('punishment').values({
        account_id: record.accountId,
        username: record.username,
        kind: record.kind,
        issued_at: record.issuedAt,
        until: record.until,
        automated: record.automated,
        issued_by_account_id: record.issuedByAccountId,
        note: null,
        lifted_at: null
    });
}

/**
 * The public record for one account, or the newest across everybody when
 * `accountId` is null. No issuer and no note of who lifted it: `staff` names
 * never leave the database, which is the rule `public_punishments` enforces on
 * the website's side and this mirrors on the shell's.
 */
export function punishmentsQuery(database: Kysely<DB>, accountId: number | null, limit: number) {
    const query = database.selectFrom('punishment').select(['id', 'username', 'kind', 'issued_at', 'until', 'automated', 'note', 'lifted_at']).orderBy('issued_at', 'desc').orderBy('id', 'desc').limit(limit);

    return accountId === null ? query : query.where('account_id', '=', accountId);
}

/**
 * Lifting is the reversal, and it only touches punishments that are still in
 * force: one that has already run its course was not lifted by anybody, and
 * stamping it would make the public page say a moderator did something they
 * did not do.
 *
 * `now` goes in as a Date, not a `toDbDate` string: kysely types a comparison
 * against the column's *read* type. Every backend binds it - the sqlite driver
 * formats it with the same `toSqlDateTime` `toDbDate` uses. The value being
 * *written* is the string, as everywhere else.
 *
 * `kinds` is which of the two are being undone. Both, usually; one when the
 * operator said so. The website's `staff_lift` takes a punishment id and so
 * lifts exactly one row by construction - this is the shell's coarser door, and
 * "unban this player but leave the mute standing" is a thing moderators
 * actually want, so the coarse door needs a way to say it.
 */
export function liftPunishmentsQuery(database: Kysely<DB>, accountId: number, liftedAt: string, liftedByAccountId: number | null, now: Date, kinds: readonly PunishmentKind[] = PUNISHMENT_KINDS) {
    return database
        .updateTable('punishment')
        .set({
            lifted_at: liftedAt,
            lifted_by_account_id: liftedByAccountId
        })
        .where('account_id', '=', accountId)
        .where('kind', 'in', [...kinds])
        .where('lifted_at', 'is', null)
        .where(eb => eb.or([eb('until', 'is', null), eb('until', '>', now)]));
}

/**
 * Every item a staff member conjured on a production world, so the economy
 * page can say what entered the game without saying who is holding it. The
 * recipient is the staff member themselves for `::give`, `::givecrap` and
 * `::givemany`, and somebody else for `::giveother`.
 *
 * `created_at` is written rather than defaulted, like every other timestamp
 * the login server writes: the value is the world's clock at the moment of the
 * spawn, not the database's at the moment of the insert.
 */
export type StaffSpawnRecord = {
    staffAccountId: number;
    targetAccountId: number | null;
    itemId: number;
    count: number;
    world: number;
    createdAt: string;
};

export function staffSpawnInsertQuery(database: Kysely<DB>, record: StaffSpawnRecord) {
    return database.insertInto('staff_spawn').values({
        staff_account_id: record.staffAccountId,
        target_account_id: record.targetAccountId,
        item_id: record.itemId,
        count: record.count,
        world: record.world,
        created_at: record.createdAt
    });
}
