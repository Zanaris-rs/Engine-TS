import { probeDatabase } from '#/db/query.js';
import { FriendServer } from '#/server/friend/FriendServer.js';
import { printFatalError } from '#/util/Logger.js';

try {
    await probeDatabase();
} catch (err) {
    printFatalError(err instanceof Error ? err : String(err));
}

const server = new FriendServer();
await server.start();
