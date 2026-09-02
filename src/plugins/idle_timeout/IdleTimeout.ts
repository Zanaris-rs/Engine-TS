import World from '#/engine/World.js';
import type Player from '#/engine/entity/Player.js';
import PluginConfig from '#/plugins/PluginConfig.js';
import Environment from '#/util/Environment.js';

// Idleness is measured by the client, not the server. It fires IDLE_TIMER after 4500 frames at
// 20ms (90s) with no mouse or keyboard input, then subtracts 500 frames so it re-fires every 10s
// while still idle. Only raw input resets it - walking and game actions do not.
const CLIENT_FIRST_IDLE_SECONDS: number = 90;
const CLIENT_REPEAT_IDLE_SECONDS: number = 10;

// Two missed repeats (10s is ~17 ticks). The client only stops sending on real input, so a gap
// longer than this means the streak ended and idleness restarted.
const STREAK_RESET_TICKS: number = 34;

type IdleStreak = {
    lastTick: number;
    seconds: number;
};

// Keyed on the player object so entries are collected with it - no Player.ts field needed.
const streaks: WeakMap<Player, IdleStreak> = new WeakMap();

export default {
    /**
     * Returns true when this plugin has taken responsibility for the packet and the engine
     * default must be skipped, false to fall through to stock behaviour.
     */
    onIdleTimer(player: Player): boolean {
        // debug mode disables idle logout outright; leave that to the engine default
        if (Environment.node.debug) {
            return false;
        }

        // anything at or below the client's own threshold is stock behaviour
        if (PluginConfig.idleTimeout <= CLIENT_FIRST_IDLE_SECONDS) {
            return false;
        }

        const previous = streaks.get(player);
        const continuing = typeof previous !== 'undefined' && World.currentTick - previous.lastTick <= STREAK_RESET_TICKS;

        // packet k of a streak arrives at 90 + 10(k - 1) seconds of idleness
        const streak: IdleStreak = {
            lastTick: World.currentTick,
            seconds: continuing ? previous.seconds + CLIENT_REPEAT_IDLE_SECONDS : CLIENT_FIRST_IDLE_SECONDS
        };
        streaks.set(player, streak);

        if (streak.seconds >= PluginConfig.idleTimeout) {
            player.requestIdleLogout = true;
        }

        return true;
    }
};
