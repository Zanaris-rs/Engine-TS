import assert from 'node:assert/strict';
import test from 'node:test';

import { failureReplyFor, handleWithFailureReply, retryReply, type ReplySocket } from '#/server/login/LoginMessage.js';

// what ws-sync actually generates: waiterPrefix + '_' + uuidv4()
const REPLY_ID = 'id_ac41d945-0f2a-4e37-9f1e-8b2c6d1f0a44';

function fakeSocket() {
    const sent: unknown[] = [];

    const socket: ReplySocket = {
        send(data: string) {
            sent.push(JSON.parse(data));
        }
    };

    return { socket, sent };
}

test('a failed player_login is answered with response 7, on the string id ws-sync generates', () => {
    assert.deepEqual(failureReplyFor({ type: 'player_login', replyTo: REPLY_ID, username: 'bob' }), { replyTo: REPLY_ID, response: 7 });
});

test('numeric ids are still accepted, for hand-written probes and older callers', () => {
    assert.deepEqual(failureReplyFor({ type: 'player_login', replyTo: 42 }), { replyTo: 42, response: 7 });
    assert.deepEqual(failureReplyFor({ type: 'player_login', replyTo: 0 }), { replyTo: 0, response: 7 });
});

test('a failed player_logout is answered with success: false, so the world retries', () => {
    assert.deepEqual(failureReplyFor({ type: 'player_logout', replyTo: REPLY_ID, username: 'bob' }), { replyTo: REPLY_ID, success: false });
});

test('genuinely fire-and-forget message types are not answered', () => {
    // ws-sync matches an incoming payload against every outstanding request, so
    // a stray reply would be handed to whichever one happens to be in flight
    for (const type of ['world_startup', 'player_autosave', 'player_force_logout', 'player_ban', 'player_mute']) {
        assert.equal(failureReplyFor({ type, replyTo: REPLY_ID }), null, type);
    }
});

test('a message with no usable replyTo is not answered', () => {
    assert.equal(failureReplyFor({ type: 'player_login' }), null);
    assert.equal(failureReplyFor({ type: 'player_login', replyTo: '' }), null);
    assert.equal(failureReplyFor({ type: 'player_login', replyTo: null }), null);
    assert.equal(failureReplyFor({ type: 'player_logout', replyTo: {} }), null);
});

test('unparseable or non-object input is not answered', () => {
    assert.equal(failureReplyFor(undefined), null);
    assert.equal(failureReplyFor(null), null);
    assert.equal(failureReplyFor('player_login'), null);
    assert.equal(failureReplyFor([{ type: 'player_login', replyTo: REPLY_ID }]), null);
});

test('retryReply is the opcode the client shows as "please try again"', () => {
    assert.deepEqual(retryReply(REPLY_ID), { replyTo: REPLY_ID, response: 7 });
});

// the wiring itself: exactly what LoginServer runs for every incoming message

test('a handler that throws before replying still answers a login', async () => {
    const { socket, sent } = fakeSocket();

    await handleWithFailureReply(JSON.stringify({ type: 'player_login', replyTo: REPLY_ID, username: 'bob' }), socket, async () => {
        throw new Error('no such table: session');
    });

    assert.deepEqual(sent, [{ replyTo: REPLY_ID, response: 7 }]);
});

test('a handler that throws before replying still answers a logout', async () => {
    const { socket, sent } = fakeSocket();

    await handleWithFailureReply(JSON.stringify({ type: 'player_logout', replyTo: REPLY_ID, username: 'bob' }), socket, async () => {
        throw new Error('connection terminated unexpectedly');
    });

    assert.deepEqual(sent, [{ replyTo: REPLY_ID, success: false }]);
});

test('a handler that already replied is not answered a second time', async () => {
    const { socket, sent } = fakeSocket();

    // this is the real shape of the bug it guards: the account_login update runs
    // after the success reply has gone out
    await handleWithFailureReply(JSON.stringify({ type: 'player_login', replyTo: REPLY_ID }), socket, async (_message, sendReply) => {
        sendReply({ replyTo: REPLY_ID, response: 0, account_id: 7 });
        throw new Error('update account_login failed');
    });

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { replyTo: REPLY_ID, response: 0, account_id: 7 });
});

test('a handler that succeeds sends exactly what it sent', async () => {
    const { socket, sent } = fakeSocket();

    await handleWithFailureReply(JSON.stringify({ type: 'player_login', replyTo: REPLY_ID }), socket, async (_message, sendReply) => {
        sendReply({ replyTo: REPLY_ID, response: 0 });
    });

    assert.deepEqual(sent, [{ replyTo: REPLY_ID, response: 0 }]);
});

test('a throw on a fire-and-forget message sends nothing', async () => {
    const { socket, sent } = fakeSocket();

    await handleWithFailureReply(JSON.stringify({ type: 'player_autosave', username: 'bob' }), socket, async () => {
        throw new Error('disk full');
    });

    assert.deepEqual(sent, []);
});

test('unparseable json sends nothing and does not escape', async () => {
    const { socket, sent } = fakeSocket();
    let ran = false;

    await handleWithFailureReply('{ not json', socket, async () => {
        ran = true;
    });

    assert.equal(ran, false);
    assert.deepEqual(sent, []);
});

test('the message is handed to the handler parsed', async () => {
    const { socket } = fakeSocket();
    let seen: unknown;

    await handleWithFailureReply(JSON.stringify({ type: 'world_startup', nodeId: 10 }), socket, async message => {
        seen = message;
    });

    assert.deepEqual(seen, { type: 'world_startup', nodeId: 10 });
});
