import { probeDatabase } from '#/db/query.js';
import LoginServer from '#/server/login/LoginServer.js';
import { printFatalError } from '#/util/Logger.js';

try {
    await probeDatabase();
} catch (err) {
    printFatalError(err instanceof Error ? err : String(err));
}

new LoginServer();
