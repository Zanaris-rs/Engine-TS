import Player from '#/engine/entity/Player.js';
import ClientGameMessageHandler from '#/network/game/client/ClientGameMessageHandler.js';
import IdleTimer from '#/network/game/client/model/IdleTimer.js';
import Environment from '#/util/Environment.js';
import Plugins from '#/plugins/Plugins.js'; // @plugin-hook

export default class IdleTimerHandler extends ClientGameMessageHandler<IdleTimer> {
    handle(_message: IdleTimer, player: Player): boolean {
        if (Plugins.onIdleTimer(player)) return true; // @plugin-hook
        if (!Environment.node.debug) {
            // todo: staff command to stay logged in
            player.requestIdleLogout = true;
        }

        return true;
    }
}
