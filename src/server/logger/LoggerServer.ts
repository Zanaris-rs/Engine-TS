import { WebSocket, WebSocketServer } from 'ws';

import { fromDbDate } from '#/db/DateFormat.js';
import { db, toDbDate } from '#/db/query.js';
import { SessionLog } from '#/engine/entity/tracking/SessionLog.js';
import { WealthTransactionEvent } from '#/engine/entity/tracking/WealthEvent.js';
import type { EvidenceEndMessage, ReportEvidenceMessage } from '#/server/logger/index.d.js';
import Environment from '#/util/Environment.js';
import { printInfo } from '#/util/Logger.js';

/**
 * How far back a report reaches for the offender's own chat. The friend server
 * sweeps `public_chat` and `private_chat` an hour after they were said, so this
 * copy is the only thing that keeps any of it.
 */
const CHAT_BEFORE_MS = 30 * 60 * 1000;

/** Lines copied per window per kind. A report is evidence, not a transcript. */
const CHAT_COPY_LIMIT = 500;

/**
 * Evidence writes allowed to be in flight at once.
 *
 * The engine's pool is three connections and has no statement queue worth the
 * name: a stalled database plus a world dumping sixteen chunks per report for
 * five reports at once is how a logger process turns into an unbounded pile of
 * pending promises. Past this the message is dropped and counted, which is a
 * gap in one report rather than a logger that has stopped answering at all.
 */
const MAX_EVIDENCE_WRITES = 64;

export default class LoggerServer {
    private server: WebSocketServer;

    private evidenceWrites: number = 0;
    private evidenceDropped: number = 0;

    constructor() {
        this.server = new WebSocketServer({ port: Environment.logger.port, host: '0.0.0.0' }, () => {
            printInfo(`Logger server listening on port ${Environment.logger.port}`);
        });

        this.server.on('connection', (socket: WebSocket) => {
            socket.on('message', async (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());
                    const { type } = msg;

                    switch (type) {
                        case 'session_log': {
                            const { logs } = msg;

                            const schemaLogs = logs.map((x: SessionLog) => ({
                                session_uuid: x.session_uuid,
                                timestamp: toDbDate(x.timestamp),
                                coord: x.coord,
                                event: x.event,
                                event_type: x.event_type
                            }));

                            await db.insertInto('session_log').values(schemaLogs).execute();
                            break;
                        }
                        case 'wealth_event': {
                            const { events } = msg;

                            const schemaEvents = events.map((x: WealthTransactionEvent) => ({
                                session_uuid: x.session_uuid,
                                timestamp: toDbDate(x.timestamp),
                                coord: x.coord,
                                event_type: x.event_type,

                                account_items: JSON.stringify(x.account_items),
                                account_value: x.account_value,

                                recipient_session: x.recipient_session,
                                recipient_items: x.recipient_items ? JSON.stringify(x.recipient_items) : null,
                                recipient_value: x.recipient_value
                            }));

                            await db.insertInto('session_wealth').values(schemaEvents).execute();
                            break;
                        }
                        case 'report': {
                            const { session_uuid, timestamp, coord, offender, reason } = msg;

                            await db
                                .insertInto('report')
                                .values({
                                    session_uuid,
                                    timestamp: toDbDate(timestamp),
                                    coord,
                                    offender,
                                    reason
                                })
                                .execute();

                            break;
                        }
                        case 'input_track': {
                            const { session_uuid, timestamp, buf } = msg;

                            await db
                                .insertInto('input_report')
                                .values({
                                    session_uuid,
                                    timestamp: toDbDate(timestamp),
                                    data: Buffer.from(buf, 'base64')
                                })
                                .execute();
                            break;
                        }
                        case 'report_evidence': {
                            if (this.admit()) {
                                try {
                                    await this.writeEvidence(msg as ReportEvidenceMessage);
                                } finally {
                                    this.evidenceWrites--;
                                }
                            }
                            break;
                        }
                        case 'evidence_end': {
                            if (this.admit()) {
                                try {
                                    await this.endEvidence(msg as EvidenceEndMessage);
                                } finally {
                                    this.evidenceWrites--;
                                }
                            }
                            break;
                        }
                    }
                } catch (err) {
                    console.error(err);
                }
            });

            socket.on('close', () => {});
            socket.on('error', () => {});
        });
    }

    /** Take a slot, or count the drop and say no. */
    private admit(): boolean {
        if (this.evidenceWrites >= MAX_EVIDENCE_WRITES) {
            this.evidenceDropped++;

            // once per hundred, so a stall is visible in the journal without
            // becoming the reason the journal is full
            if (this.evidenceDropped % 100 === 1) {
                printInfo(`Logger dropped ${this.evidenceDropped} evidence messages: ${MAX_EVIDENCE_WRITES} writes already in flight`);
            }

            return false;
        }

        this.evidenceWrites++;
        return true;
    }

    /**
     * File one chunk, and - when it is the first chunk of its report - copy the
     * half hour of the offender's chat that led up to it, before the friend
     * server's hourly sweep takes it away.
     *
     * `(report_uuid, seq)` is deliberately not unique (one uuid covers several
     * reports of the same macroer), so the same chunk arriving twice, which the
     * world's retry queue can do, has to be caught here instead.
     */
    private async writeEvidence(msg: ReportEvidenceMessage): Promise<void> {
        const existing = await db.selectFrom('report_input').select('id').where('report_uuid', '=', msg.report_uuid).limit(1).executeTakeFirst();

        if (existing) {
            const duplicate = await db.selectFrom('report_input').select('id').where('report_uuid', '=', msg.report_uuid).where('seq', '=', msg.seq).limit(1).executeTakeFirst();

            if (duplicate) {
                return;
            }
        }

        await db
            .insertInto('report_input')
            .values({
                report_uuid: msg.report_uuid,
                seq: msg.seq,
                kind: msg.capture,
                client: msg.client,
                started_at: toDbDate(msg.started_at),
                flushed_at: toDbDate(msg.flushed_at),
                data: Buffer.from(msg.data, 'base64')
            })
            .execute();

        if (!existing && msg.offender_account_id !== null) {
            await this.copyChat(msg.report_uuid, msg.offender_account_id, new Date(msg.report_at - CHAT_BEFORE_MS), '>=', new Date(msg.report_at));
        }
    }

    /** The window has closed: copy the chat from the other side of the report. */
    private async endEvidence(msg: EvidenceEndMessage): Promise<void> {
        if (msg.offender_account_id === null) {
            return;
        }

        await this.copyChat(msg.report_uuid, msg.offender_account_id, new Date(msg.report_at), '>', new Date(msg.ended_at));
    }

    /**
     * The offender's own chat in one window: what they said out loud, and the
     * private messages they sent. Not what was said to them - the report is
     * about them, and the other half of a conversation belongs to whoever else
     * was in it.
     *
     * The window is deleted before it is written, so a message the world had to
     * retry rewrites its half rather than doubling it. The before and after
     * windows never overlap (one ends at the report instant, the other starts
     * after it), so neither can erase the other.
     *
     * The bounds go in as `Date`s and the copied timestamps come back out
     * through `toDbDate`: Kysely types a comparison against the column's read
     * type, the sqlite driver formats a Date into the same UTC string it stores,
     * and pg and mysql2 bind one natively. Nothing here writes `now()`.
     */
    private async copyChat(report_uuid: string, account_id: number, from: Date, fromOp: '>' | '>=', to: Date): Promise<void> {
        await db.deleteFrom('report_chat').where('report_uuid', '=', report_uuid).where('at', fromOp, from).where('at', '<=', to).execute();

        const said = await db
            .selectFrom('public_chat')
            .innerJoin('session', 'session.uuid', 'public_chat.session_uuid')
            .select(['public_chat.timestamp as at', 'public_chat.coord as coord', 'public_chat.message as message'])
            .where('session.account_id', '=', account_id)
            .where('public_chat.timestamp', fromOp, from)
            .where('public_chat.timestamp', '<=', to)
            .orderBy('public_chat.timestamp')
            .limit(CHAT_COPY_LIMIT)
            .execute();

        const sent = await db
            .selectFrom('private_chat')
            .leftJoin('account', 'account.id', 'private_chat.to_account_id')
            .select(['private_chat.timestamp as at', 'private_chat.coord as coord', 'private_chat.message as message', 'account.username as to_username'])
            .where('private_chat.account_id', '=', account_id)
            .where('private_chat.timestamp', fromOp, from)
            .where('private_chat.timestamp', '<=', to)
            .orderBy('private_chat.timestamp')
            .limit(CHAT_COPY_LIMIT)
            .execute();

        const rows = [
            ...said.map(row => ({
                report_uuid,
                at: toDbDate(fromDbDate(row.at)),
                kind: 'public',
                to_username: null,
                coord: row.coord,
                message: row.message
            })),
            ...sent.map(row => ({
                report_uuid,
                at: toDbDate(fromDbDate(row.at)),
                kind: 'private_sent',
                to_username: row.to_username,
                coord: row.coord,
                message: row.message
            }))
        ];

        if (rows.length === 0) {
            return;
        }

        await db.insertInto('report_chat').values(rows).execute();
    }
}
