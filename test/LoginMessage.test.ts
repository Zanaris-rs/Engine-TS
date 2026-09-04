import assert from 'node:assert/strict';
import test from 'node:test';

import { loginRetryReplyTo } from '#/server/login/LoginMessage.js';

test('a failed player_login still owes the world a reply', () => {
    assert.equal(loginRetryReplyTo({ type: 'player_login', replyTo: 42, username: 'bob' }), 42);
    assert.equal(loginRetryReplyTo({ type: 'player_login', replyTo: 0 }), 0);
});

test('fire-and-forget message types are not answered', () => {
    // answering these would put an unexpected payload in front of whatever
    // request the world actually has outstanding
    for (const type of ['world_startup', 'player_logout', 'player_autosave', 'player_force_logout', 'player_ban', 'player_mute']) {
        assert.equal(loginRetryReplyTo({ type, replyTo: 42 }), null, type);
    }
});

test('a player_login with no usable replyTo is not answered', () => {
    assert.equal(loginRetryReplyTo({ type: 'player_login' }), null);
    assert.equal(loginRetryReplyTo({ type: 'player_login', replyTo: 'forty-two' }), null);
    assert.equal(loginRetryReplyTo({ type: 'player_login', replyTo: null }), null);
});

test('unparseable or non-object input is not answered', () => {
    // `parsed` is left undefined when JSON.parse itself threw
    assert.equal(loginRetryReplyTo(undefined), null);
    assert.equal(loginRetryReplyTo(null), null);
    assert.equal(loginRetryReplyTo('player_login'), null);
    assert.equal(loginRetryReplyTo([{ type: 'player_login', replyTo: 1 }]), null);
});
