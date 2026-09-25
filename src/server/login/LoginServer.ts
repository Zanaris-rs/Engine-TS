import fs from 'fs';
import fsp from 'fs/promises';

import * as bcrypt from 'bcrypt-ts';
import { WebSocket, WebSocketServer } from 'ws';

import { fromDbDate } from '#/db/DateFormat.js';
import { db, toDbDate } from '#/db/query.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import { INTERNAL_MAX_PAYLOAD } from '#/server/InternalClient.js';
import { lookOf, recordAdventure } from '#/server/login/Adventure.js';
import { postReport, reportWebhookUrl } from '#/server/login/DiscordReports.js';
import { updateHiscores } from '#/server/login/Hiscores.js';
import { handleWithFailureReply, retryReply, type ReplyId, type SendReply } from '#/server/login/LoginMessage.js';
import {
    banNotice,
    countUnread,
    isAutomatedActor,
    muteNotice,
    type ModerationNotice,
    NOTICE_DUPLICATE_WINDOW_MS,
    type PunishmentKind,
    punishmentInsertQuery,
    recentNoticeQuery,
    rewriteNoticeQuery,
    staffSpawnInsertQuery
} from '#/server/login/MessageCentre.js';
import Environment from '#/util/Environment.js';
import { toSafeName } from '#/util/JString.js';
import { printInfo } from '#/util/Logger.js';
import { startManagementWeb } from '#/web.js';
import InvType from '#/cache/config/InvType.js';

/**
 * Where Report Abuse is announced, read once at startup. Null - the usual case
 * on a developer's machine - means reports are written and nobody is pinged.
 * The inbox link is optional and not a secret; it rides in the same env file
 * because that is the one file the login unit reads.
 */
const REPORT_WEBHOOK_URL = reportWebhookUrl();
const REPORT_INBOX_URL = process.env.DISCORD_REPORT_INBOX_URL?.trim() || undefined;

/** The look a loaded save holds, for `account_look`. */
function lookOfPlayer(player: Player) {
    return lookOf(player.body, player.colors, player.gender, player.getInventory(InvType.WORN));
}

async function loadAccount(username: string, profile: string) {
    return await db
        .selectFrom('account')
        .leftJoin('account_login', join => join.onRef('account_id', '=', 'id').on('profile', '=', profile))
        .where('username', '=', username)
        .selectAll()
        .executeTakeFirst();
}

/**
 * The number on the client's welcome screen. A player logs in to play, not to
 * read their inbox, so a database hiccup here costs them nothing: the count
 * comes back 0 and the login goes on. `countUnread` has already clamped it to
 * the 65535 the LAST_LOGIN_INFO packet can carry.
 */
async function unreadFor(accountId: number): Promise<number> {
    try {
        return await countUnread(db, accountId);
    } catch (err) {
        console.error('unread count failed for account_id %s', accountId, err);
        return 0;
    }
}

/**
 * A ban or a mute leaves a message behind, so the player has somewhere to read
 * what happened and somewhere to appeal - which is what the client's own "check
 * your message-centre" screen has always told them to do.
 *
 * A second ban inside the hour rewrites the first notice rather than adding
 * one: a moderator extending a ban, or an automated check firing twice, is one
 * decision, not three messages - but it is the *latest* decision, so the
 * unread row is overwritten with the new expiry and the new author rather than
 * left standing. Dropping the second one used to leave the player reading an
 * expiry that no longer matched `account.banned_until`.
 */
async function writeModerationNotice(username: string, notice: ModerationNotice, staffUsername: string) {
    try {
        const account = await db.selectFrom('account').select('id').where('username', '=', username).executeTakeFirst();

        if (!account) {
            return;
        }

        // 'automated' is the report-abuse and spam paths' actor, not a person:
        // it is a reserved username, so there is no row to find and the notice
        // is written with no author - which is what "an automated check" in the
        // body already tells the player.
        const staff = isAutomatedActor(staffUsername) ? undefined : await db.selectFrom('account').select('id').where('username', '=', staffUsername).executeTakeFirst();

        const recent = await recentNoticeQuery(db, account.id, notice.kind, new Date(Date.now() - NOTICE_DUPLICATE_WINDOW_MS)).executeTakeFirst();

        if (recent) {
            await rewriteNoticeQuery(db, recent.id, notice, staff?.id ?? null, toDbDate(new Date())).execute();
            return;
        }

        await db
            .insertInto('account_message')
            .values({
                account_id: account.id,
                kind: notice.kind,
                subject: notice.subject,
                body: notice.body,
                // null for the automated paths, which have no account behind them
                created_by_account_id: staff?.id ?? null
            })
            .execute();
    } catch (err) {
        // the ban itself has already landed; losing the courtesy note must not
        // turn a moderation action into an unhandled rejection
        console.error('could not write the %s notice for %s', notice.kind, username, err);
    }
}

/**
 * The permanent half of a ban or a mute.
 *
 * The notice above is a message and can be rewritten; this row is the public
 * record and never is. A ban extended from five minutes to a week leaves one
 * notice - the true one - and two punishment rows, because two decisions were
 * taken and `/bans` shows the history rather than the latest state.
 *
 * It is a separate try/catch from the notice on purpose. They are two
 * independent consequences of one decision, and the account row that actually
 * stops the login has already been written by the time either runs: a database
 * failure should cost at most one of them.
 */
async function recordPunishment(kind: PunishmentKind, username: string, until: Date, staffUsername: string) {
    try {
        const account = await db.selectFrom('account').select('id').where('username', '=', username).executeTakeFirst();

        if (!account) {
            return;
        }

        const automated = isAutomatedActor(staffUsername);
        const staff = automated ? undefined : await db.selectFrom('account').select('id').where('username', '=', staffUsername).executeTakeFirst();

        await punishmentInsertQuery(db, {
            accountId: account.id,
            username,
            kind,
            issuedAt: toDbDate(new Date()),
            until: toDbDate(until),
            automated,
            // the public page says "automated" or "a moderator" and nothing
            // more, but the id is what a staff audit needs to exist at all
            issuedByAccountId: staff?.id ?? null
        }).execute();
    } catch (err) {
        console.error('could not record the %s of %s', kind, username, err);
    }
}

/**
 * How far back the fallback will look for the offender's session.
 *
 * The point of `offender_session_uuid` is to be the key the logger's
 * `public_chat` and `session_wealth` rows are filed under, so a staff member
 * reading the report is reading what the offender did *around the offence*. A
 * session from last month is not that: the offender was somewhere else, doing
 * something else, and pointing the report at it is worse than pointing it at
 * nothing, because a null says "we do not know" and a stale uuid says "here".
 */
const OFFENDER_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Who a report is about.
 *
 * The world fills these two in only when the offender happened to be on it -
 * which is the common case, but not a cross-world report and not a report of
 * somebody who logged off between the offence and the Report Abuse screen. The
 * login server has the whole account table, so it finishes the job: the account
 * by username, and then that account's newest session on this profile, as long
 * as it started inside {@link OFFENDER_SESSION_WINDOW_MS} of the report.
 *
 * The account has no such window - an account is the same account whenever it
 * was last seen, and the report is about a person.
 *
 * A lookup failure is not worth losing the report over, so it falls back to
 * whatever the world managed to resolve - null included. The row still names
 * the offender.
 */
/**
 * The reporter's name for the Discord embed. The world sends only the account
 * id, and a failed lookup is worth "unknown" in a notification, not a report
 * that never reached the channel.
 */
async function reporterName(accountId: number | null): Promise<string | null> {
    if (accountId === null) {
        return null;
    }

    try {
        const account = await db.selectFrom('account').select('username').where('id', '=', accountId).executeTakeFirst();
        return account?.username ?? null;
    } catch (err) {
        console.error('reporter lookup failed for account_id %s', accountId, err);
        return null;
    }
}

async function resolveOffender(profile: string, offender: string, reportedAt: Date, accountId: number | null, sessionUuid: string | null): Promise<{ accountId: number | null; sessionUuid: string | null }> {
    if (accountId !== null && sessionUuid !== null) {
        return { accountId, sessionUuid };
    }

    try {
        let id = accountId;

        if (id === null) {
            const account = await db.selectFrom('account').select('id').where('username', '=', toSafeName(offender)).executeTakeFirst();
            id = account?.id ?? null;
        }

        let session = sessionUuid;

        if (session === null && id !== null) {
            // the window bound goes in as a Date: kysely types a comparison
            // against the column's read type, and every backend binds one -
            // the sqlite driver formats it with the same `toSqlDateTime`
            // `toDbDate` uses
            const since = new Date(reportedAt.getTime() - OFFENDER_SESSION_WINDOW_MS);

            const newest = await db.selectFrom('session').select('uuid').where('account_id', '=', id).where('profile', '=', profile).where('timestamp', '>', since).orderBy('timestamp', 'desc').limit(1).executeTakeFirst();
            session = newest?.uuid ?? null;
        }

        return { accountId: id, sessionUuid: session };
    } catch (err) {
        console.error('could not resolve the offender %s for a report', offender, err);
        return { accountId, sessionUuid };
    }
}

export default class LoginServer {
    private server: WebSocketServer;
    private loginRequests: Set<string> = new Set();

    // Send opcode 7 ('Please try again') if something has gone wrong during a
    // login attempt, which may be resolved by simply retrying. Goes through
    // sendReply rather than the socket so it counts as having answered.
    //
    // replyTo is a string in production: ws-sync builds it as 'id_<uuid>'.
    rejectLoginForSafety(sendReply: SendReply, replyTo: ReplyId) {
        sendReply(retryReply(replyTo));
    }

    async wouldResetSaveFile(newSaveBytes: Buffer, profile: string, username: string) {
        // check whether `save`, if saved to disk, would have reset `username`'s progress.
        // it does this by checking whether the player's tick count has gone backwards.
        if (!fs.existsSync(`data/players/${profile}/${username}.sav`)) {
            // No existing save - no problem.
            return false;
        }
        const existingSaveRaw = await fsp.readFile(`data/players/${profile}/${username}.sav`);
        const existingSave = PlayerLoading.load('tmp', new Packet(existingSaveRaw), null);
        const newSave = PlayerLoading.load('tmp', new Packet(newSaveBytes), null);
        if (existingSave.playtime > newSave.playtime) {
            // Int32, 1 per tick logged in. Should wrap only after insane amount of years.
            return true;
        }
        return false;
    }

    constructor() {
        if (Environment.login.enabled && !Environment.easyStartup) {
            startManagementWeb();
        }

        InvType.load('data/pack');

        this.server = new WebSocketServer({ port: Environment.login.port, host: '0.0.0.0', maxPayload: INTERNAL_MAX_PAYLOAD }, () => {
            printInfo(`Login server listening on port ${Environment.login.port}`);
        });

        this.server.on('connection', (s: WebSocket) => {
            s.on('message', async (data: Buffer) => {
                // handleWithFailureReply owns the parse, the try/catch and the
                // answer-on-failure: a throw anywhere below must not leave the
                // world blocking on fetchSync for its full ten second timeout
                await handleWithFailureReply(data.toString(), s, async (message, sendReply) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const msg = message as any;
                    const { type, nodeId, nodeTime, profile } = msg;

                    if (type === 'world_startup') {
                        await db
                            .updateTable('account_login')
                            .set({
                                logged_in: 0,
                                login_time: null
                            })
                            .where('logged_in', '=', nodeId)
                            .where('profile', '=', profile)
                            .execute();
                    } else if (type === 'player_login') {
                        const { nodeMembers, replyTo, username, password, uid, socket, remoteAddress, reconnecting, hasSave } = msg;
                        const safeName = toSafeName(username);

                        if (this.loginRequests.has(safeName)) {
                            sendReply({
                                replyTo,
                                response: 8
                            });
                            return;
                        }
                        this.loginRequests.add(safeName);

                        try {
                            const ipBan = await db.selectFrom('ipban').selectAll().where('ip', '=', remoteAddress).executeTakeFirst();

                            if (ipBan) {
                                sendReply({
                                    replyTo,
                                    response: 7
                                });
                                return;
                            }

                            let account = await loadAccount(username, profile);

                            if (Environment.account.autoCreate && !account) {
                                // register the user automatically
                                //
                                // no insertId gate: kysely's postgres driver never sets one, and
                                // where this path is enabled it is the only way to get an account
                                // at all - a missing insertId would hang every new player with no
                                // reply. executeTakeFirstOrThrow surfaces a real failure to the
                                // catch below instead.
                                //
                                // email is NOT NULL, and nothing here can ask for one.
                                await db
                                    .insertInto('account')
                                    .values({
                                        username,
                                        password: bcrypt.hashSync(password.toLowerCase(), 10),
                                        email: `${toSafeName(username)}@localhost`,
                                        email_normalized: `${toSafeName(username)}@localhost`,
                                        registration_ip: remoteAddress,
                                        registration_date: toDbDate(new Date())
                                    })
                                    .executeTakeFirstOrThrow();

                                account = await loadAccount(username, profile);
                            }

                            if (!account || !(await bcrypt.compare(password.toLowerCase(), account.password))) {
                                // invalid username or password
                                sendReply({
                                    replyTo,
                                    response: 1
                                });
                                return;
                            }

                            if (account.banned_until !== null && fromDbDate(account.banned_until) > new Date()) {
                                // account disabled
                                sendReply({
                                    replyTo,
                                    response: 5
                                });
                                return;
                            }

                            if (account.playable_after !== null && fromDbDate(account.playable_after) > new Date()) {
                                // still soaking after signup - the same reply as a ban,
                                // because the client has no other "not yet" response
                                sendReply({
                                    replyTo,
                                    response: 5
                                });
                                return;
                            }

                            if (nodeMembers && !account.members) {
                                if (Environment.node.autoSubscribeMembers) {
                                    // Set members=1 for the account and proceed with login
                                    await db.updateTable('account').where('id', '=', account.id).set('members', true).executeTakeFirstOrThrow();
                                    account.members = true;
                                } else {
                                    sendReply({
                                        replyTo,
                                        response: 9
                                    });
                                    return;
                                }
                            }

                            if (reconnecting && account.logged_in === nodeId) {
                                await db
                                    .insertInto('session')
                                    .values({
                                        uuid: socket,
                                        account_id: account.id,
                                        profile,
                                        world: nodeId,
                                        timestamp: toDbDate(nodeTime),
                                        uid,
                                        ip: remoteAddress
                                    })
                                    .execute();

                                if (!hasSave) {
                                    const save = await fsp.readFile(`data/players/${profile}/${username}.sav`);
                                    if (!save || !PlayerLoading.verify(new Packet(save))) {
                                        // Extreme safety check for savefile existing but having bad data on read:
                                        console.error('on reconnect, account_id %s had invalid save data on disk', account.id);
                                        this.rejectLoginForSafety(sendReply, replyTo);
                                        return;
                                    }
                                    sendReply({
                                        replyTo,
                                        response: 2,
                                        account_id: account.id,
                                        staffmodlevel: account.staffmodlevel,
                                        muted_until: account.muted_until,
                                        save: save.toString('base64'),
                                        members: account.members,
                                        // a reconnect does not reopen the welcome screen, so
                                        // the count is never read: not worth a query
                                        messageCount: 0
                                    });
                                } else {
                                    sendReply({
                                        replyTo,
                                        response: 2,
                                        account_id: account.id,
                                        staffmodlevel: account.staffmodlevel,
                                        muted_until: account.muted_until,
                                        members: account.members,
                                        messageCount: 0
                                    });
                                }
                                return;
                            } else if (account.logged_in !== null && account.logged_in !== 0) {
                                // already logged in elsewhere
                                sendReply({
                                    replyTo,
                                    response: 3
                                });
                                return;
                            } else if (account.staffmodlevel < 2 && account.logged_out !== 0 && account.logged_out !== nodeId && account.logout_time !== null) {
                                const remaining = fromDbDate(account.logout_time).getTime() - (Date.now() - Environment.node.hopTime);
                                if (remaining > 0) {
                                    // rate limited (hop timer)
                                    sendReply({
                                        replyTo,
                                        response: 10,
                                        remaining
                                    });
                                    return;
                                }
                            }

                            await db
                                .insertInto('session')
                                .values({
                                    uuid: socket,
                                    account_id: account.id,
                                    profile,
                                    world: nodeId,
                                    timestamp: toDbDate(nodeTime),
                                    uid,
                                    ip: remoteAddress
                                })
                                .execute();

                            // The unread count is fetched on the two paths that
                            // actually answer with one, and nowhere else: every
                            // reply above returns before it, and so do the two
                            // save-file rejections below, so no attempt that
                            // ends in "please try again" pays for the query.
                            if (!fs.existsSync(`data/players/${profile}/${username}.sav`)) {
                                // not an error - never logged in before
                                // ^ Only not an error if the user has never logged in before:
                                if (account.logout_time !== null) {
                                    console.error('on login, account_id %s had no save data on disk!', account.id);
                                    this.rejectLoginForSafety(sendReply, replyTo);
                                    return;
                                } else {
                                    const messageCount = await unreadFor(account.id);

                                    sendReply({
                                        replyTo,
                                        response: 4,
                                        account_id: account.id,
                                        staffmodlevel: account.staffmodlevel,
                                        muted_until: account.muted_until,
                                        // the one reply that never sent it: World reads
                                        // `members` off the login message and a brand new
                                        // player was arriving as undefined
                                        members: account.members,
                                        messageCount
                                    });
                                }
                            } else {
                                const save = await fsp.readFile(`data/players/${profile}/${username}.sav`);
                                // Extreme safety check for savefile existing but having bad data on read:
                                if (!save || !PlayerLoading.verify(new Packet(save))) {
                                    console.error('on login, account_id %s had invalid save data on disk!', account.id);
                                    this.rejectLoginForSafety(sendReply, replyTo);
                                    return;
                                }

                                const messageCount = await unreadFor(account.id);

                                sendReply({
                                    replyTo,
                                    response: 0,
                                    account_id: account.id,
                                    staffmodlevel: account.staffmodlevel,
                                    save: save.toString('base64'),
                                    muted_until: account.muted_until,
                                    members: account.members,
                                    messageCount
                                });
                            }

                            // Login is valid - update account table
                            if (account.account_id) {
                                await db
                                    .updateTable('account_login')
                                    .set({
                                        logged_in: nodeId,
                                        login_time: toDbDate(new Date())
                                    })
                                    .where('account_id', '=', account.id)
                                    .where('profile', '=', profile)
                                    .executeTakeFirst();
                            } else {
                                await db
                                    .insertInto('account_login')
                                    .values({
                                        account_id: account.id,
                                        profile: profile,
                                        logged_in: nodeId,
                                        login_time: toDbDate(new Date())
                                    })
                                    .executeTakeFirst();
                            }
                        } finally {
                            this.loginRequests.delete(safeName);
                        }
                    } else if (type === 'player_logout') {
                        const { replyTo, username, save, adventure } = msg;

                        const raw = Buffer.from(save, 'base64');
                        let saved = false;
                        if (PlayerLoading.verify(new Packet(raw)) && !(await this.wouldResetSaveFile(raw, profile, username))) {
                            if (!fs.existsSync(`data/players/${profile}`)) {
                                await fsp.mkdir(`data/players/${profile}`, { recursive: true });
                            }

                            await fsp.writeFile(`data/players/${profile}/${username}.sav`, raw);
                            saved = true;
                        } else {
                            console.error(username, 'Invalid save file');
                        }

                        const account = await loadAccount(username, profile);

                        if (account?.account_id) {
                            await db
                                .updateTable('account_login')
                                .set({
                                    logged_in: 0,
                                    login_time: null,
                                    logged_out: nodeId,
                                    logout_time: toDbDate(new Date())
                                })
                                .where('account_id', '=', account.id)
                                .where('profile', '=', profile)
                                .executeTakeFirst();
                        }

                        sendReply({
                            replyTo,
                            response: 0
                        });

                        // after the reply on purpose: the world only needs to know the
                        // save landed, and a hiscore failure must not turn an
                        // acknowledged logout into a retry
                        const player = PlayerLoading.load(username, new Packet(raw), null);
                        await updateHiscores(account, player, profile);

                        // only with a save that was written: the log must not keep
                        // what the save it came with did not
                        if (saved) {
                            await recordAdventure(account, profile, lookOfPlayer(player), adventure);
                        }
                    } else if (type === 'player_autosave') {
                        const { username, save, adventure } = msg;

                        const raw = Buffer.from(save, 'base64');
                        if (PlayerLoading.verify(new Packet(raw)) && !(await this.wouldResetSaveFile(raw, profile, username))) {
                            if (!fs.existsSync(`data/players/${profile}`)) {
                                await fsp.mkdir(`data/players/${profile}`, { recursive: true });
                            }

                            await fsp.writeFile(`data/players/${profile}/${username}.sav`, raw);
                        } else {
                            console.error(username, 'Invalid save file');
                            return;
                        }

                        // hiscores would otherwise only move on a clean logout, so a
                        // player who never logs off cleanly never appears at all
                        const account = await loadAccount(username, profile);
                        const player = PlayerLoading.load(username, new Packet(raw), null);
                        await updateHiscores(account, player, profile);
                        await recordAdventure(account, profile, lookOfPlayer(player), adventure);
                    } else if (type === 'player_force_logout') {
                        const { username } = msg;

                        const account = await loadAccount(username, profile);

                        if (account?.account_id) {
                            await db
                                .updateTable('account_login')
                                .set({
                                    logged_in: 0,
                                    login_time: null
                                })
                                .where('account_id', '=', account.id)
                                .where('profile', '=', profile)
                                .executeTakeFirst();
                        }
                    } else if (type === 'player_ban') {
                        const { staff, username, until } = msg;

                        // todo: audit log

                        await db
                            .updateTable('account')
                            .set({
                                banned_until: toDbDate(until)
                            })
                            .where('username', '=', username)
                            .executeTakeFirst();

                        await recordPunishment('ban', username, new Date(until), staff);
                        await writeModerationNotice(username, banNotice(staff, new Date(until)), staff);
                    } else if (type === 'player_mute') {
                        const { staff, username, until } = msg;

                        // todo: audit log

                        await db
                            .updateTable('account')
                            .set({
                                muted_until: toDbDate(until)
                            })
                            .where('username', '=', username)
                            .executeTakeFirst();

                        await recordPunishment('mute', username, new Date(until), staff);
                        await writeModerationNotice(username, muteNotice(staff, new Date(until)), staff);
                    } else if (type === 'player_report') {
                        // Report Abuse used to go to the logger thread, and the
                        // logger server is disabled on this fleet, so every report
                        // was dropped while the player was thanked for it. The
                        // login server has the database the staff inbox reads, and
                        // it is the only writer of this table now.
                        const { account_id, session_uuid, coord, offender, reason, uuid, offender_account_id, offender_session_uuid, offender_coord } = msg;

                        // `uuid` is the evidence key the world generated, and
                        // the only thing joining this row to the input and chat
                        // the logger server filed under it. It is null when
                        // nothing was captured: any reason but macroing or bug
                        // abuse, or an offender who was not online to capture.
                        const reportedAt = new Date(nodeTime ?? Date.now());

                        const offenderIds = await resolveOffender(
                            profile,
                            offender,
                            reportedAt,
                            typeof offender_account_id === 'number' && offender_account_id > 0 ? offender_account_id : null,
                            typeof offender_session_uuid === 'string' ? offender_session_uuid : null
                        );

                        await db
                            .insertInto('report')
                            .values({
                                session_uuid,
                                timestamp: toDbDate(reportedAt),
                                coord,
                                offender,
                                reason,
                                // -1 is the world's "we never got an account_id",
                                // which is not a row anyone can join to
                                reporter_account_id: typeof account_id === 'number' && account_id > 0 ? account_id : null,
                                world: nodeId,
                                uuid: typeof uuid === 'string' ? uuid : null,
                                offender_account_id: offenderIds.accountId,
                                offender_session_uuid: offenderIds.sessionUuid,
                                // there is no coord on a `session` row, so this
                                // one is only ever what the world saw
                                offender_coord: typeof offender_coord === 'number' ? offender_coord : null
                            })
                            .execute();

                        // Only once the row exists: Discord is the ping, the
                        // table is the record. Not awaited - the socket handler
                        // is back to its next message while Discord answers.
                        if (REPORT_WEBHOOK_URL !== null) {
                            const reporterAccountId = typeof account_id === 'number' && account_id > 0 ? account_id : null;

                            void reporterName(reporterAccountId).then(reporter =>
                                postReport(
                                    REPORT_WEBHOOK_URL,
                                    {
                                        reporter,
                                        offender: String(offender),
                                        reason: Number(reason),
                                        world: typeof nodeId === 'number' ? nodeId : null,
                                        coord: Number(coord),
                                        offenderCoord: typeof offender_coord === 'number' ? offender_coord : null,
                                        reportedAt,
                                        uuid: typeof uuid === 'string' ? uuid : null
                                    },
                                    REPORT_INBOX_URL
                                )
                            );
                        }
                    } else if (type === 'player_spawn') {
                        // Every item-creating cheat on a production world, so
                        // the economy page can account for what a moderator
                        // added alongside what players mined and killed for.
                        const { staff_account_id, target_account_id, item_id, count, world } = msg;

                        // `msg` is `any` - it is whatever arrived on a socket -
                        // so every column of this row is checked, not just the
                        // nullable ones. The three that cannot be null are the
                        // reason the whole message is dropped rather than
                        // written with a NaN or an undefined in it.
                        if (typeof staff_account_id !== 'number' || staff_account_id <= 0 || typeof item_id !== 'number' || typeof count !== 'number' || count <= 0) {
                            console.error('ignoring a malformed player_spawn from world %s', nodeId);
                            return;
                        }

                        await staffSpawnInsertQuery(db, {
                            staffAccountId: staff_account_id,
                            targetAccountId: typeof target_account_id === 'number' && target_account_id > 0 ? target_account_id : null,
                            itemId: item_id,
                            count,
                            // the world names itself in the message; nodeId is
                            // the same number off the connection it arrived on
                            world: typeof world === 'number' ? world : nodeId,
                            createdAt: toDbDate(nodeTime ?? Date.now())
                        }).execute();
                    }
                });
            });

            s.on('close', () => {});
            s.on('error', () => {});
        });
    }
}
