import { WebSocket } from 'ws';

import WsSyncReq from '#3rdparty/ws-sync/ws-sync.js';

/**
 * The most one message of the internal protocol may be, in bytes.
 *
 * A property of the protocol rather than of any one server, which is why it
 * lives beside the client that speaks it: the login, friend and logger servers
 * all pass it to their `WebSocketServer`.
 *
 * `ws` defaults to 100 MiB, and every one of these servers `JSON.parse`s the
 * frame it is handed. The three of them bind 0.0.0.0 and are kept private by a
 * security group and a WireGuard link rather than by the bind address, so the
 * thing this is sized against is not a hostile internet - it is a
 * misconfigured security group, a world on the wrong port, or a bug in this
 * repo, any of which would otherwise be a hub process buffering and parsing a
 * hundred megabytes on one socket.
 *
 * A megabyte is two orders of magnitude more than the largest thing that
 * legitimately crosses: an input chunk is 1500 bytes before base64, a session
 * log batch is a few hundred rows. Anything above this is not a message anybody
 * here meant to send, and the socket closes with 1009 rather than reading it.
 */
export const INTERNAL_MAX_PAYLOAD = 1024 * 1024;

export default class InternalClient {
    protected ws: WebSocket | null = null;
    protected wsr: WsSyncReq | null = null;

    private host: string;
    private port: number;

    /**
     * The connect in progress, if any.
     *
     * Without it, callers that arrive together each open a socket: the second
     * overwrites `this.ws` while the first is still opening, so the `WsSyncReq`
     * the first one builds on 'open' wraps a socket that is not yet live, and
     * every one of those sends is reported as failed. It shows up as a burst of
     * messages - the sixteen chunks of a macro report's ring, say - arriving as
     * one message and fifteen retries.
     */
    private connecting: Promise<void> | null = null;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
    }

    async connect(): Promise<void> {
        if (this.wsr && this.wsr.checkIfWsLive()) {
            return;
        }

        this.connecting ??= this.open().finally(() => {
            this.connecting = null;
        });

        return this.connecting;
    }

    private open(): Promise<void> {
        return new Promise(res => {
            this.ws = new WebSocket(`ws://${this.host}:${this.port}`, {
                timeout: 5000
            });

            const timeout = setTimeout(() => {
                if (this.ws) {
                    this.ws.terminate();
                }

                this.ws = null;
                this.wsr = null;
                res();
            }, 10000);

            this.ws.once('close', () => {
                clearTimeout(timeout);

                this.ws = null;
                this.wsr = null;
                res();
            });

            this.ws.once('error', () => {
                clearTimeout(timeout);

                this.ws = null;
                this.wsr = null;
                res();
            });

            this.ws.once('open', () => {
                clearTimeout(timeout);

                this.wsr = new WsSyncReq(this.ws);
                res();
            });

            this.ws.on('message', (buf: Buffer) => {
                try {
                    const message = JSON.parse(buf.toString());

                    this.messageHandlers.forEach(fn => fn(message.type, message));
                } catch (err) {
                    console.error(err);
                }
            });
        });
    }

    private messageHandlers: ((opcode: number, data: unknown) => void)[] = [];

    public async onMessage(fn: (opcode: number, data: unknown) => void) {
        this.messageHandlers.push(fn);
    }
}
