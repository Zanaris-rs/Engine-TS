import fs from 'fs';
import fsp from 'fs/promises';

import * as bcrypt from 'bcrypt-ts';
import { WebSocket, WebSocketServer } from 'ws';

import { fromDbDate } from '#/db/DateFormat.js';
import { db, toDbDate } from '#/db/query.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import { updateHiscores } from '#/server/login/Hiscores.js';
import Environment from '#/util/Environment.js';
import { toSafeName } from '#/util/JString.js';
import { printInfo } from '#/util/Logger.js';
import { startManagementWeb } from '#/web.js';
import InvType from '#/cache/config/InvType.js';

async function loadAccount(username: string, profile: string) {
    return await db
        .selectFrom('account')
        .leftJoin('account_login', join => join.onRef('account_id', '=', 'id').on('profile', '=', profile))
        .where('username', '=', username)
        .selectAll()
        .executeTakeFirst();
}

export default class LoginServer {
    private server: WebSocketServer;
    private loginRequests: Set<string> = new Set();

    rejectLoginForSafety(s: WebSocket, replyTo: number) {
        // Send opcode 7 ('Please try again') if something has gone wrong
        // during login attempt, which may be resolved by simply retrying.
        s.send(
            JSON.stringify({
                replyTo,
                response: 7
            })
        );
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

        this.server = new WebSocketServer({ port: Environment.login.port, host: '0.0.0.0' }, () => {
            printInfo(`Login server listening on port ${Environment.login.port}`);
        });

        this.server.on('connection', (s: WebSocket) => {
            s.on('message', async (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());
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
                            s.send(
                                JSON.stringify({
                                    replyTo,
                                    response: 8
                                })
                            );
                            return;
                        }
                        this.loginRequests.add(safeName);

                        try {
                            const ipBan = await db.selectFrom('ipban').selectAll().where('ip', '=', remoteAddress).executeTakeFirst();

                            if (ipBan) {
                                s.send(
                                    JSON.stringify({
                                        replyTo,
                                        response: 7
                                    })
                                );
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
                                s.send(
                                    JSON.stringify({
                                        replyTo,
                                        response: 1
                                    })
                                );
                                return;
                            }

                            if (account.banned_until !== null && fromDbDate(account.banned_until) > new Date()) {
                                // account disabled
                                s.send(
                                    JSON.stringify({
                                        replyTo,
                                        response: 5
                                    })
                                );
                                return;
                            }

                            if (account.playable_after !== null && fromDbDate(account.playable_after) > new Date()) {
                                // still soaking after signup - the same reply as a ban,
                                // because the client has no other "not yet" response
                                s.send(
                                    JSON.stringify({
                                        replyTo,
                                        response: 5
                                    })
                                );
                                return;
                            }

                            if (nodeMembers && !account.members) {
                                if (Environment.node.autoSubscribeMembers) {
                                    // Set members=1 for the account and proceed with login
                                    await db.updateTable('account').where('id', '=', account.id).set('members', true).executeTakeFirstOrThrow();
                                    account.members = true;
                                } else {
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 9
                                        })
                                    );
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
                                        this.rejectLoginForSafety(s, replyTo);
                                    }
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 2,
                                            account_id: account.id,
                                            staffmodlevel: account.staffmodlevel,
                                            muted_until: account.muted_until,
                                            save: save.toString('base64'),
                                            members: account.members,
                                            messageCount: 0
                                        })
                                    );
                                } else {
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 2,
                                            account_id: account.id,
                                            staffmodlevel: account.staffmodlevel,
                                            muted_until: account.muted_until,
                                            members: account.members,
                                            messageCount: 0
                                        })
                                    );
                                }
                                return;
                            } else if (account.logged_in !== null && account.logged_in !== 0) {
                                // already logged in elsewhere
                                s.send(
                                    JSON.stringify({
                                        replyTo,
                                        response: 3
                                    })
                                );
                                return;
                            } else if (account.staffmodlevel < 2 && account.logged_out !== 0 && account.logged_out !== nodeId && account.logout_time !== null) {
                                const remaining = fromDbDate(account.logout_time).getTime() - (Date.now() - Environment.node.hopTime);
                                if (remaining > 0) {
                                    // rate limited (hop timer)
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 10,
                                            remaining
                                        })
                                    );
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

                            if (!fs.existsSync(`data/players/${profile}/${username}.sav`)) {
                                // not an error - never logged in before
                                // ^ Only not an error if the user has never logged in before:
                                if (account.logout_time !== null) {
                                    console.error('on login, account_id %s had no save data on disk!', account.id);
                                    this.rejectLoginForSafety(s, replyTo);
                                    return;
                                } else {
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 4,
                                            account_id: account.id,
                                            staffmodlevel: account.staffmodlevel,
                                            muted_until: account.muted_until,
                                            messageCount: 0
                                        })
                                    );
                                }
                            } else {
                                const save = await fsp.readFile(`data/players/${profile}/${username}.sav`);
                                // Extreme safety check for savefile existing but having bad data on read:
                                if (!save || !PlayerLoading.verify(new Packet(save))) {
                                    console.error('on login, account_id %s had invalid save data on disk!', account.id);
                                    this.rejectLoginForSafety(s, replyTo);
                                    return;
                                }
                                s.send(
                                    JSON.stringify({
                                        replyTo,
                                        response: 0,
                                        account_id: account.id,
                                        staffmodlevel: account.staffmodlevel,
                                        save: save.toString('base64'),
                                        muted_until: account.muted_until,
                                        members: account.members,
                                        messageCount: 0
                                    })
                                );
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
                        const { replyTo, username, save } = msg;

                        const raw = Buffer.from(save, 'base64');
                        if (PlayerLoading.verify(new Packet(raw)) && !(await this.wouldResetSaveFile(raw, profile, username))) {
                            if (!fs.existsSync(`data/players/${profile}`)) {
                                await fsp.mkdir(`data/players/${profile}`, { recursive: true });
                            }

                            await fsp.writeFile(`data/players/${profile}/${username}.sav`, raw);
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

                        s.send(
                            JSON.stringify({
                                replyTo,
                                response: 0
                            })
                        );

                        await updateHiscores(account, PlayerLoading.load(username, new Packet(raw), null), profile);
                    } else if (type === 'player_autosave') {
                        const { username, save } = msg;

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
                        await updateHiscores(account, PlayerLoading.load(username, new Packet(raw), null), profile);
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
                        const { _staff, username, until } = msg;

                        // todo: audit log

                        await db
                            .updateTable('account')
                            .set({
                                banned_until: toDbDate(until)
                            })
                            .where('username', '=', username)
                            .executeTakeFirst();
                    } else if (type === 'player_mute') {
                        const { _staff, username, until } = msg;

                        // todo: audit log

                        await db
                            .updateTable('account')
                            .set({
                                muted_until: toDbDate(until)
                            })
                            .where('username', '=', username)
                            .executeTakeFirst();
                    }
                } catch (err) {
                    console.error(err);
                }
            });

            s.on('close', () => {});
            s.on('error', () => {});
        });
    }
}
