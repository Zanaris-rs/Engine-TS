import fs from 'fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort } from 'worker_threads';

import { LoginClient } from '#/server/login/LoginClient.js';
import Environment from '#/util/Environment.js';
import { printError, printInfo } from '#/util/Logger.js';

import { type GenericLoginThreadResponse } from './index.d.js';
import { trackLoginAttempts, trackLoginTime } from './LoginMetrics.js';

const client = new LoginClient(Environment.node.id);

if (!parentPort) throw new Error('This file must be run as a worker thread.');

parentPort.on('message', async msg => {
    try {
        if (!parentPort) throw new Error('This file must be run as a worker thread.');
        await handleRequests(parentPort, msg);
    } catch (err) {
        console.error(err);
    }
});

client.onMessage((opcode, data) => {
    parentPort!.postMessage({ opcode, data });
});

type ParentPort = {
    postMessage: (msg: GenericLoginThreadResponse) => void;
};

async function handleRequests(parentPort: ParentPort, msg: any) {
    const { type } = msg;

    switch (type) {
        case 'world_startup': {
            if (Environment.login.enabled) {
                // world_startup clears this world's stale account_login rows, so keep
                // retrying until the login server is actually up to receive it.
                //
                // Say so once. The loop is silent otherwise on purpose - a few retries
                // are normal while a fleet comes up - but a world stuck here logs
                // "World ready" and then refuses every login with nothing in the
                // journal to explain it. One line on the way down, one on the way back.
                let failedAttempts = 0;

                while (!(await client.worldStartup())) {
                    if (failedAttempts === 0) {
                        printError('Login server unreachable, retrying world_startup every 5s');
                    }

                    failedAttempts++;
                    await sleep(5000);
                }

                if (failedAttempts > 0) {
                    printInfo(`Login server reachable, world_startup accepted after ${failedAttempts} failed attempt(s)`);
                }
            }
            break;
        }
        case 'player_login': {
            const { socket, remoteAddress, username, password, uid, lowMemory, reconnecting, hasSave } = msg;

            if (Environment.login.enabled) {
                trackLoginAttempts.inc();
                const stopTimer = trackLoginTime.startTimer();
                const response = await client.playerLogin(username, password, uid, socket, remoteAddress, reconnecting, hasSave);

                if (!Environment.node.production) {
                    response.staffmodlevel = 4; // dev (destructive commands)
                }

                parentPort.postMessage({
                    type: 'player_login',
                    socket,
                    username,
                    lowMemory,
                    reconnecting,
                    ...response
                });
                stopTimer();
            } else {
                let staffmodlevel = 0;

                if (!Environment.node.production) {
                    staffmodlevel = 4; // dev (destructive commands)
                }

                const profile = Environment.node.profile;
                if (!fs.existsSync(`data/players/${profile}`)) {
                    fs.mkdirSync(`data/players/${profile}`, { recursive: true });
                }

                if (!fs.existsSync(`data/players/${profile}/${username}.sav`)) {
                    parentPort.postMessage({
                        type: 'player_login',
                        socket,
                        username,
                        lowMemory,
                        reconnecting,
                        reply: 4,
                        staffmodlevel,
                        save: null,
                        account_id: 1,
                        members: Environment.node.members
                    });
                } else {
                    parentPort.postMessage({
                        type: 'player_login',
                        socket,
                        username,
                        lowMemory,
                        reconnecting,
                        reply: 0,
                        staffmodlevel,
                        save: fs.readFileSync(`data/players/${profile}/${username}.sav`),
                        account_id: 1,
                        members: Environment.node.members
                    });
                }
            }
            break;
        }
        case 'player_logout': {
            const { username, save } = msg;

            if (Environment.login.enabled) {
                const success = await client.playerLogout(username, save);

                parentPort.postMessage({
                    type: 'player_logout',
                    username,
                    success
                });
            } else {
                const profile = Environment.node.profile;
                if (!fs.existsSync(`data/players/${profile}`)) {
                    fs.mkdirSync(`data/players/${profile}`, { recursive: true });
                }

                fs.writeFileSync(`data/players/${profile}/${username}.sav`, save);

                parentPort.postMessage({
                    type: 'player_logout',
                    username,
                    success: true
                });
            }
            break;
        }
        case 'player_autosave': {
            const { username, save } = msg;

            if (Environment.login.enabled) {
                await client.playerAutosave(username, save);
            } else {
                const profile = Environment.node.profile;
                if (!fs.existsSync(`data/players/${profile}`)) {
                    fs.mkdirSync(`data/players/${profile}`, { recursive: true });
                }

                fs.writeFileSync(`data/players/${profile}/${username}.sav`, save);
            }
            break;
        }
        case 'player_force_logout': {
            if (Environment.login.enabled) {
                const { username } = msg;
                await client.playerForceLogout(username);
            }
            break;
        }
        case 'player_ban': {
            if (Environment.login.enabled) {
                // todo: wait for confirmation? resend?
                const { staff, username, until } = msg;
                await client.playerBan(staff, username, until);
            }
            break;
        }
        case 'player_mute': {
            if (Environment.login.enabled) {
                // todo: wait for confirmation? resend?
                const { staff, username, until } = msg;
                await client.playerMute(staff, username, until);
            }
            break;
        }
        case 'player_report': {
            if (Environment.login.enabled) {
                // fire and forget, like the ban and mute above
                const { account_id, session_uuid, coord, offender, reason, uuid, offender_account_id, offender_session_uuid, offender_coord } = msg;
                await client.playerReport({
                    account_id,
                    session_uuid,
                    coord,
                    offender,
                    reason,
                    // null unless the offender was on this world when the
                    // report was filed; the login server resolves the account
                    // from the username either way
                    uuid: uuid ?? null,
                    offender_account_id: offender_account_id ?? null,
                    offender_session_uuid: offender_session_uuid ?? null,
                    offender_coord: offender_coord ?? null
                });
            }
            break;
        }
        case 'player_spawn': {
            if (Environment.login.enabled) {
                // fire and forget: the item already exists, and the world is
                // not waiting to hear that the log caught up
                const { staff_account_id, target_account_id, item_id, count, world } = msg;
                await client.playerSpawn({ staff_account_id, target_account_id, item_id, count, world });
            }
            break;
        }
        case 'world_heartbeat': {
            break;
        }
        default:
            console.error('Unknown message type: ' + msg.type);
            break;
    }
}
