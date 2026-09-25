/**
 * How long chat is kept, and how it is deleted.
 *
 * Its own module for the reason `MessageCentre` is one: the friend server opens
 * a websocket in its constructor, and a retention rule that can only be
 * exercised by starting a server is a retention rule nothing exercises.
 * Everything here takes the database as an argument, so `test/ChatSweep.test.ts`
 * runs the real loop against a real sqlite file with a real quarter of a
 * million rows in it.
 */
import type { Kysely } from 'kysely';

import type { DB } from '#/db/types.js';

/**
 * How long chat is kept.
 *
 * `public_chat` and `private_chat` have been written since the Postgres
 * cutover with no retention and no reader: every line anybody has said in game
 * is still in the database. An hour is long enough for the two things that
 * actually read it - a moderator looking at a report, and the logger server
 * copying the offender's own lines into `report_chat` - and short enough that
 * the table is not a standing record of everybody's conversations.
 *
 * The writer is the reaper on purpose: this runs on sqlite dev worlds too,
 * where there is no pg_cron to fall back on.
 */
export const CHAT_RETENTION_MS = 60 * 60 * 1000;

/** How often the sweep runs, and how long it waits before its first pass. */
export const CHAT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const CHAT_SWEEP_DELAY_MS = 60_000;

/**
 * Rows deleted per statement.
 *
 * One unbounded `delete ... where timestamp < $1` is a few thousand rows on an
 * ordinary hour and a scan-and-delete of everything ever said on the *first*
 * one - or on the first one after a sweep that could not run. That is the shape
 * that meets a `statement_timeout` and rolls back, so the retention that was
 * too big to enforce goes on never being enforced and the next hour has an hour
 * more to delete. It is also, on postgres, one transaction holding row locks
 * over a table the worlds are still writing to.
 *
 * Ten thousand finishes well inside any timeout, and an ordinary hour is still
 * one statement. Each batch commits on its own, so a run that stops halfway
 * keeps what it deleted.
 */
export const CHAT_SWEEP_BATCH = 10_000;

/** The two tables this sweeps. Both are (id, timestamp, ...). */
export type ChatTable = 'public_chat' | 'private_chat';

/**
 * One batch of expired rows.
 *
 * `delete ... where id in (select id ... limit n)` rather than a `LIMIT` on the
 * delete itself, because postgres has no such clause; the inner select is
 * wrapped in a derived table because mysql refuses a subquery that reads the
 * table the delete is writing (error 1093) unless it is materialised first.
 * sqlite and postgres are indifferent to the extra nesting, so this is one
 * statement all three accept.
 *
 * The cutoff goes in as a `Date`: Kysely types a comparison against the
 * column's read type, the sqlite driver formats one into the same UTC string it
 * stored, and pg and mysql2 bind one natively. Nothing here writes `now()`.
 */
export function expiredChatQuery(database: Kysely<DB>, table: ChatTable, cutoff: Date, limit: number = CHAT_SWEEP_BATCH) {
    return database.deleteFrom(table).where('id', 'in', eb => eb.selectFrom(eb.selectFrom(table).select('id').where('timestamp', '<', cutoff).limit(limit).as('expired')).select('expired.id'));
}

/** What one table's sweep did, and whether it finished. */
export type ChatSweepResult = { deleted: number; stopped: boolean };

/**
 * One table's expired rows, {@link CHAT_SWEEP_BATCH} at a time, until a
 * statement deletes fewer rows than it asked for - which is how a limited
 * delete says "that was the last of them" without a second count query.
 *
 * A failed batch stops this table rather than retrying: whatever stopped it - a
 * timeout, a pooler that went away - will not be different eight milliseconds
 * later, the rows are still there for the next hour, and what has already been
 * deleted stays deleted because every batch is its own statement.
 */
export async function sweepChatTable(database: Kysely<DB>, table: ChatTable, cutoff: Date, batch: number = CHAT_SWEEP_BATCH): Promise<ChatSweepResult> {
    let deleted = 0;

    for (;;) {
        let removed: number;

        try {
            const result = await expiredChatQuery(database, table, cutoff, batch).executeTakeFirst();

            removed = Number(result?.numDeletedRows ?? 0);
        } catch (err) {
            console.error(err);
            return { deleted, stopped: true };
        }

        deleted += removed;

        if (removed < batch) {
            return { deleted, stopped: false };
        }
    }
}

/**
 * Both tables, and the one line the operator's journal gets per run.
 *
 * A public sweep that gave up was stopped by something the private one is about
 * to meet as well, so the run stops rather than failing twice an hour into the
 * same journal.
 */
export async function sweepChat(database: Kysely<DB>, now: number = Date.now(), batch: number = CHAT_SWEEP_BATCH): Promise<{ cutoff: Date; said: ChatSweepResult; sent: ChatSweepResult; message: string }> {
    const cutoff = new Date(now - CHAT_RETENTION_MS);

    const said = await sweepChatTable(database, 'public_chat', cutoff, batch);
    const sent = said.stopped ? { deleted: 0, stopped: true } : await sweepChatTable(database, 'private_chat', cutoff, batch);

    const stopped = said.stopped || sent.stopped ? ' - a batch failed, so the rest waits for the next run' : '';

    return { cutoff, said, sent, message: `[Friends]: swept ${said.deleted} public and ${sent.deleted} private chat rows older than ${cutoff.toISOString()}${stopped}` };
}
