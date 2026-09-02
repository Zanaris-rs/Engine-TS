import type Player from '#/engine/entity/Player.js';
import PluginConfig from '#/plugins/PluginConfig.js';

export default {
    onLogin(player: Player): void {
        if (PluginConfig.loginMotd.length === 0) {
            return;
        }

        player.messageGame(PluginConfig.loginMotd);
    }
};
