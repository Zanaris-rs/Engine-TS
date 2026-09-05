import InternalClient from '#/server/InternalClient.js';
import type { EvidenceMessage } from '#/server/logger/index.d.js';
import Environment from '#/util/Environment.js';

export default class LoggerClient extends InternalClient {
    constructor() {
        super(Environment.logger.host, Environment.logger.port);
    }

    /**
     * Everything goes out the same way: connect if the socket is down, and say
     * whether the message actually left. Session logs and wealth events ignore
     * the answer - one lost batch is one lost batch - but evidence does not,
     * because a chunk of a macro report has no second chance to be recorded.
     */
    private async forward(message: object): Promise<boolean> {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return false;
        }

        this.ws.send(
            JSON.stringify({
                world: Environment.node.id,
                profile: Environment.node.profile,
                ...message
            })
        );

        return true;
    }

    public async sessionLog(logs: string[]) {
        await this.forward({ type: 'session_log', logs });
    }

    public async wealthEvent(events: string[]) {
        await this.forward({ type: 'wealth_event', events });
    }

    // no report(): Report Abuse goes to the login server now, which owns the
    // `report` table and knows who pressed the button. LoggerServer still
    // handles the opcode, for a world old enough to send it.

    // no inputTrack() either: `input_report` was written by nothing and read by
    // nothing. A report's input is `report_evidence` now, keyed by the uuid
    // both hub servers share.

    public async evidence(message: EvidenceMessage): Promise<boolean> {
        return this.forward(message);
    }
}
