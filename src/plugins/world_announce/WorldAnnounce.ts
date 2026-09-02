import World from '#/engine/World.js';
import PluginConfig from '#/plugins/PluginConfig.js';

// World.TICKRATE is private and documented as fixed.
const MS_PER_TICK: number = 600;

let nextAnnounceTick: number = -1;

export default {
    onCycle(currentTick: number): void {
        if (PluginConfig.announceInterval <= 0 || PluginConfig.announceMessage.length === 0) {
            return;
        }

        const interval: number = Math.max(1, Math.round((PluginConfig.announceInterval * 1000) / MS_PER_TICK));

        // don't broadcast on the very first cycle, wait a full interval
        if (nextAnnounceTick === -1) {
            nextAnnounceTick = currentTick + interval;
            return;
        }

        if (currentTick >= nextAnnounceTick) {
            nextAnnounceTick = currentTick + interval;
            World.broadcastMes(PluginConfig.announceMessage);
        }
    }
};
