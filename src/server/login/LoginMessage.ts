/**
 * Kept free of any database or socket import so the error path can be unit
 * tested without standing a login server up.
 */

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `replyTo` a failed message still owes an answer to, or null when nothing
 * is waiting on one.
 *
 * Only `player_login` blocks a caller: the world sends it through `fetchSync`,
 * which polls for a reply and gives up after ten seconds. Every other message
 * type is fire-and-forget, and answering one would put an unexpected payload in
 * front of whatever request is actually outstanding.
 */
export function loginRetryReplyTo(message: unknown): number | null {
    if (!isObject(message)) {
        return null;
    }

    if (message.type !== 'player_login') {
        return null;
    }

    if (typeof message.replyTo !== 'number') {
        return null;
    }

    return message.replyTo;
}
