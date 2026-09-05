import InternalClient from '#/server/InternalClient.js';
import Environment from '#/util/Environment.js';

export default class LoggerClient extends InternalClient {
    constructor() {
        super(Environment.logger.host, Environment.logger.port);
    }

    public async sessionLog(logs: string[]) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: 'session_log',
                world: Environment.node.id,
                profile: Environment.node.profile,
                logs
            })
        );
    }

    public async wealthEvent(events: string[]) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: 'wealth_event',
                world: Environment.node.id,
                profile: Environment.node.profile,
                events
            })
        );
    }

    // no report(): Report Abuse goes to the login server now, which owns the
    // `report` table and knows who pressed the button. LoggerServer still
    // handles the opcode, for a world old enough to send it.

    public async inputTrack(session_uuid: string, timestamp: number, buf: string) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: 'input_track',
                session_uuid,
                timestamp,
                buf
            })
        );
    }
}
