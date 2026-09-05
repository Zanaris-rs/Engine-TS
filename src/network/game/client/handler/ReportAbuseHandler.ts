import Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import ClientGameMessageHandler from '#/network/game/client/ClientGameMessageHandler.js';
import ReportAbuse, { ReportAbuseReason } from '#/network/game/client/model/ReportAbuse.js';
import Environment from '#/util/Environment.js';
import { fromBase37 } from '#/util/JString.js';

/**
 * One report per player per 30 seconds. `reportAbuseProtect` is cleared every
 * tick in `Player.resetEntity`, so on its own it only stops two reports in the
 * same 600ms - a modified client could hold the report interface open and post
 * one row into `report` every tick for as long as it liked. Nobody reporting
 * in good faith needs a second one inside half a minute.
 */
export const REPORT_ABUSE_COOLDOWN = 30000;

/**
 * The same line either way, on purpose: a report that was thrown away answers
 * exactly as a report that landed did, so a client cannot time the window by
 * watching what comes back. `true` for the same reason - it is what tells
 * NetworkPlayer to charge the packet to the user-event budget.
 */
const RECEIVED = 'Thank-you, your abuse report has been received';

export default class ReportAbuseHandler extends ClientGameMessageHandler<ReportAbuse> {
    handle(message: ReportAbuse, player: Player): boolean {
        if (player.reportAbuseProtect) {
            return false;
        }

        if (message.reason < ReportAbuseReason.OFFENSIVE_LANGUAGE || message.reason > ReportAbuseReason.REAL_WORLD_TRADING) {
            World.notifyPlayerBan('automated', player.username, Date.now() + 172800000);
            return false;
        }

        const now = Date.now();

        if (now - player.lastReportAbuse < REPORT_ABUSE_COOLDOWN) {
            // nothing is written - not the report, and not the moderator mute
            // that would have ridden along with it
            player.messageGame(RECEIVED);
            player.reportAbuseProtect = true;
            return true;
        }

        if (message.moderatorMute && player.staffModLevel > 0 && Environment.node.production) {
            // 2 day mute
            World.notifyPlayerMute(player.username, fromBase37(message.offender), Date.now() + 172800000);
        }

        World.notifyPlayerReport(player, fromBase37(message.offender), message.reason);
        player.messageGame(RECEIVED);
        player.lastReportAbuse = now;
        player.reportAbuseProtect = true;
        return true;
    }
}
