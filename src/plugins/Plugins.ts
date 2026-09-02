import type Player from '#/engine/entity/Player.js';
import IdleTimeout from '#/plugins/idle_timeout/IdleTimeout.js';
import LoginMotd from '#/plugins/login_motd/LoginMotd.js';
import WorldAnnounce from '#/plugins/world_announce/WorldAnnounce.js';

/**
 * The single entry point every engine seam imports. Seams are two added lines - an import and a
 * call - and never modify an existing line, so they rebase cleanly onto new upstream revisions.
 * See PLUGINS.md for the seam manifest and the update runbook.
 */
export default {
    /** Returns true when a plugin handled the packet and the engine default must be skipped. */
    onIdleTimer(player: Player): boolean {
        return IdleTimeout.onIdleTimer(player);
    },

    onLogin(player: Player): void {
        LoginMotd.onLogin(player);
    },

    onCycle(currentTick: number): void {
        WorldAnnounce.onCycle(currentTick);
    }
};
