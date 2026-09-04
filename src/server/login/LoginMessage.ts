/**
 * The login server's reply-on-failure wiring, kept free of any database, socket
 * or config import so it can be driven directly from a test.
 */

/**
 * ws-sync generates the correlation id as `waiterPrefix + '_' + uuidv4()`
 * (src/3rdparty/ws-sync/ws-sync.js:10,62,90), so in production every replyTo is
 * a **string** like 'id_ac41d945-...'. Numbers are accepted because hand-written
 * probes and older callers use them.
 */
export type ReplyId = string | number;

export interface ReplySocket {
    send(data: string): void;
}

export type SendReply = (payload: object) => void;

/** Opcode 7, 'Please try again' - the reply that exists for exactly this case. */
export function retryReply(replyTo: ReplyId): object {
    return { replyTo, response: 7 };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replyId(value: unknown): ReplyId | null {
    if (typeof value === 'number') {
        return value;
    }

    if (typeof value === 'string' && value.length > 0) {
        return value;
    }

    return null;
}

/**
 * What to send when handling `message` threw before it answered, or null when
 * nothing is waiting on a reply.
 *
 * Two message types block a caller, both through ws-sync's `fetchSync`, which
 * polls for a reply and only gives up after ten seconds:
 *
 *   player_login  (LoginClient.ts:40)  - answered with response 7, which the
 *                                       client shows as 'please try again'.
 *   player_logout (LoginClient.ts:81)  - answered with success: false, so
 *                                       LoginClient's `response === 0` check
 *                                       fails and World keeps the logout in
 *                                       logoutRequests to retry on its next
 *                                       15 second sweep (World.ts:795).
 *
 * Everything else really is fire-and-forget, and must not be answered:
 * ws-sync's receivedMessage matches an incoming payload against *every*
 * outstanding request, so a stray reply would be handed to whichever one
 * happens to be in flight.
 */
export function failureReplyFor(message: unknown): object | null {
    if (!isObject(message)) {
        return null;
    }

    const replyTo = replyId(message.replyTo);
    if (replyTo === null) {
        return null;
    }

    if (message.type === 'player_login') {
        return retryReply(replyTo);
    }

    if (message.type === 'player_logout') {
        return { replyTo, success: false };
    }

    return null;
}

/**
 * Parses one incoming message, runs `handle`, and guarantees that anything the
 * world is blocking on gets an answer even when `handle` throws.
 *
 * `handle` sends through the `sendReply` it is given rather than touching the
 * socket, so a throw *after* a successful reply is distinguishable from a throw
 * before one - the account_login update runs after the login response is sent,
 * and a second payload for a replyTo the world has already matched would
 * overwrite a successful login with a failure.
 */
export async function handleWithFailureReply(raw: string, socket: ReplySocket, handle: (message: unknown, sendReply: SendReply) => Promise<void>): Promise<void> {
    let parsed: unknown;
    let replied = false;

    const sendReply: SendReply = payload => {
        replied = true;
        socket.send(JSON.stringify(payload));
    };

    try {
        parsed = JSON.parse(raw);
        await handle(parsed, sendReply);
    } catch (err) {
        console.error(err);

        if (replied) {
            return;
        }

        const failure = failureReplyFor(parsed);
        if (failure) {
            socket.send(JSON.stringify(failure));
        }
    }
}
