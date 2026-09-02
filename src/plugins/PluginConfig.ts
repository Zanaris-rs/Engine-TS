import fs from 'fs';
import path from 'path';

import { tryParseInt, tryParseString } from '#/util/TryParse.js';

/**
 * Opt-in feature flags for everything under src/plugins.
 *
 * Every default reproduces stock upstream behaviour, so an unconfigured fork behaves
 * exactly like LostCityRS/Engine-TS. Precedence is env > data/config/plugins.json > default.
 */
export type PluginConfig = {
    /** Seconds of no client input before logout. 90 or less keeps the engine default. */
    idleTimeout: number;
    /** Message sent to a player on login. Empty disables. */
    loginMotd: string;
    /** Seconds between world broadcasts. 0 disables. */
    announceInterval: number;
    /** Message used by announceInterval. Empty disables. */
    announceMessage: string;
};

const defaults: PluginConfig = {
    idleTimeout: 90,
    loginMotd: '',
    announceInterval: 0,
    announceMessage: ''
};

// resolved against cwd, which is the engine directory - same convention as WorldConfig.ts
const pluginConfigPath = path.resolve('data/config/plugins.json');

function loadFile(): Record<string, unknown> {
    if (!fs.existsSync(pluginConfigPath)) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf8'));

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        return parsed as Record<string, unknown>;
    } catch (err) {
        console.error(`Failed to parse ${pluginConfigPath}, falling back to plugin defaults.`, err);
        return {};
    }
}

function num(env: string | undefined, file: unknown, fallback: number): number {
    const fromFile = typeof file === 'number' || typeof file === 'string' ? file : undefined;
    return tryParseInt(env, tryParseInt(fromFile, fallback));
}

function str(env: string | undefined, file: unknown, fallback: string): string {
    const fromFile = typeof file === 'string' ? file : undefined;
    return tryParseString(env, tryParseString(fromFile, fallback));
}

function loadPluginConfig(): PluginConfig {
    const file = loadFile();

    return {
        idleTimeout: num(process.env.PLUGIN_IDLE_TIMEOUT, file.idleTimeout, defaults.idleTimeout),
        loginMotd: str(process.env.PLUGIN_LOGIN_MOTD, file.loginMotd, defaults.loginMotd),
        announceInterval: num(process.env.PLUGIN_ANNOUNCE_INTERVAL, file.announceInterval, defaults.announceInterval),
        announceMessage: str(process.env.PLUGIN_ANNOUNCE_MESSAGE, file.announceMessage, defaults.announceMessage)
    };
}

export default loadPluginConfig();
