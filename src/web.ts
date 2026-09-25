import fs from 'fs';
import path from 'path';

import ejs from 'ejs';
import Fastify from 'fastify';
import FastifyStatic from '@fastify/static';
import FastifyView from '@fastify/view';
import FastifyWebsocket from '@fastify/websocket';
import { register } from 'prom-client';

import { CrcBuffer, CrcTable } from '#/cache/CrcTable.js';

import OnDemand from '#/engine/OnDemand.js';
import World from '#/engine/World.js';

import NullClientSocket from '#/server/NullClientSocket.js';

import { LoggerEventType } from '#/server/logger/LoggerEventType.js';

import WSClientSocket from '#/server/ws/WSClientSocket.js';

import Environment from '#/util/Environment.js';
import { requestShutdown } from '#/util/Shutdown.js';
import { tryParseInt } from '#/util/TryParse.js';
import { createDefaultWorldConfig, loadWorldConfig, normalizeWorldConfig, saveWorldConfig } from '#/util/WorldConfig.js';

function resolveContentPath(name: string): string | null {
    let decodedName: string;
    try {
        decodedName = decodeURIComponent(name);
    } catch {
        return null;
    }

    const contentRoot = path.resolve(Environment.build.srcDir);
    const targetPath = path.resolve(contentRoot, decodedName);
    const relativePath = path.relative(contentRoot, targetPath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }

    return targetPath;
}

function fileExists(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

// behind the reverse proxy, so req.ip resolves the real client address
const fastify = Fastify({ trustProxy: 'loopback' });

fastify.register(FastifyView, {
    engine: {
        ejs
    },
    root: 'view'
});

await fastify.register(FastifyWebsocket, {
    options: {
        maxPayload: 1600,
        perMessageDeflate: false,
        verifyClient: function (info, next) {
            if (Environment.web.allowedOrigin && info.req.headers.origin !== Environment.web.allowedOrigin) {
                next(false);
                return;
            }

            next(true);
        }
    }
});

// general routes

fastify.route({
    method: 'GET',
    url: '/',
    handler: (_req, reply) => {
        return reply.redirect('/rs2.cgi', 302);
    },
    wsHandler: (socket, req) => {
        const client = new WSClientSocket(
            {
                send(data: Uint8Array) {
                    socket.send(data);
                },
                close() {
                    socket.close();
                },
                terminate() {
                    socket.terminate();
                }
            },
            req.ip
        );

        socket.on('message', (message: Buffer<ArrayBufferLike>) => {
            try {
                if (client.state === -1 || client.remaining <= 0) {
                    client.terminate();
                    return;
                }

                client.buffer(message);

                if (client.state === 0) {
                    World.onClientData(client);
                } else if (client.state === 2) {
                    OnDemand.onClientData(client);
                }
            } catch {
                socket.terminate();
            }
        });

        socket.on('close', () => {
            client.state = -1;
            OnDemand.onClientClosed(client);

            if (client.player) {
                client.player.addSessionLog(LoggerEventType.ENGINE, 'WS socket closed');
                client.player.client = new NullClientSocket();
            }
        });

        socket.on('error', () => {
            socket.terminate();
        });
    }
});

fastify.get<{ Querystring: { plugin?: string; lowmem?: string } }>('/rs2.cgi', async (req, reply) => {
    const plugin = tryParseInt(req.query.plugin, 0);
    const lowmem = tryParseInt(req.query.lowmem, 0);

    if (Environment.node.debug && plugin === 1) {
        return reply.viewAsync('java.ejs', {
            portoff: Environment.node.port - 43594,
            nodeid: Environment.node.id,
            members: Environment.node.members,
            lowmem
        });
    } else {
        return reply.viewAsync('client.ejs', {
            nodeid: Environment.node.id,
            members: Environment.node.members,
            lowmem
        });
    }
});

// public world info, consumed by the world-select website

fastify.get('/world.json', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cache-Control', 'public, max-age=10');
    return {
        // The public world number, not the protocol node id. node.id is
        // 10-based because the client renders a friend's world as
        // "World-" + (nodeId - 9), while this endpoint, the wN hostnames and
        // the world-select site all key off 1, 2, ...
        id: Environment.node.id - 9,
        members: Environment.node.members,
        players: World.getTotalPlayers(),
        maxPlayers: Environment.node.maxConnected
    };
});

// cache routes

fastify.get('/crc:cachebust', async (_req, reply) => {
    reply.send(CrcBuffer.data);
});

fastify.get<{ Params: { crc: string } }>('/title:crc', async (req, reply) => {
    const { crc } = req.params;

    if (tryParseInt(crc, -1) !== CrcTable[1]) {
        reply.status(404);
        return;
    }

    reply.send(OnDemand.cache.read(0, 1));
});

fastify.get<{ Params: { crc: string } }>('/config:crc', async (req, reply) => {
    const { crc } = req.params;

    if (tryParseInt(crc, -1) !== CrcTable[2]) {
        reply.status(404);
        return;
    }

    reply.send(OnDemand.cache.read(0, 2));
});

fastify.get<{ Params: { crc: string } }>('/interface:crc', async (req, reply) => {
    const { crc } = req.params;

    if (tryParseInt(crc, -1) !== CrcTable[3]) {
        reply.status(404);
        return;
    }

    reply.send(OnDemand.cache.read(0, 3));
});

fastify.get<{ Params: { crc: string } }>('/media:crc', async (req, reply) => {
    const { crc } = req.params;

    if (tryParseInt(crc, -1) !== CrcTable[4]) {
        reply.status(404);
        return;
    }

    reply.send(OnDemand.cache.read(0, 4));
});

fastify.get<{ Params: { crc: string } }>('/versionlist:crc', async (req, reply) => {
    const { crc } = req.params;

    if (tryParseInt(crc, -1) !== CrcTable[5]) {
        reply.status(404);
        return;
    }

    reply.send(OnDemand.cache.read(0, 5));
});

fastify.get<{ Params: { crc: string } }>('/textures:crc', async (req, reply) => {
    const { crc } = req.params;

    if (tryParseInt(crc, -1) !== CrcTable[6]) {
        reply.status(404);
        return;
    }

    reply.send(OnDemand.cache.read(0, 6));
});

fastify.get<{ Params: { crc: string } }>('/wordenc:crc', async (req, reply) => {
    const { crc } = req.params;

    if (tryParseInt(crc, -1) !== CrcTable[7]) {
        reply.status(404);
        return;
    }

    reply.send(OnDemand.cache.read(0, 7));
});

fastify.get<{ Params: { crc: string } }>('/sounds:crc', async (req, reply) => {
    const { crc } = req.params;

    if (tryParseInt(crc, -1) !== CrcTable[8]) {
        reply.status(404);
        return;
    }

    reply.send(OnDemand.cache.read(0, 8));
});

// map editor routes

if (Environment.node.debug) {
    fastify.get('/worldmap.jag', async (_req, reply) => {
        const filePath = 'data/pack/mapview/worldmap.jag';

        if (!fileExists(filePath)) {
            reply.status(404);
            return;
        }

        return reply.type('application/octet-stream').send(fs.createReadStream(filePath));
    });

    fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
        done(null, body);
    });

    fastify.get('/maped', async (_req, reply) => {
        return reply.viewAsync('maped.ejs');
    });

    if (fs.existsSync(Environment.build.srcDir)) {
        await fastify.register(FastifyStatic, {
            root: path.resolve(Environment.build.srcDir),
            prefix: '/content/',
            decorateReply: false
        });
    }

    await fastify.register(FastifyStatic, {
        root: path.join(process.cwd(), 'data'),
        prefix: '/data/',
        decorateReply: false
    });

    fastify.put<{ Params: { '*': string } }>('/content/*', async (req, reply) => {
        const filePath = resolveContentPath(req.params['*']);
        if (!filePath) {
            reply.status(400);
            return;
        }

        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, req.body as Uint8Array);
    });
}

fastify.register(FastifyStatic, {
    root: path.join(process.cwd(), 'public')
});

export async function startWeb() {
    await fastify.listen({ port: Environment.web.port, host: Environment.web.host });
}

// management routes

const management = Fastify();

management.register(FastifyView, {
    engine: {
        ejs
    },
    root: 'view'
});

management.get('/prometheus', async (_req, reply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
});

management.get('/setup', async (_req, reply) => {
    return reply.viewAsync('setup.ejs');
});

management.get('/setup/config', async () => {
    return {
        config: loadWorldConfig(),
        defaults: createDefaultWorldConfig(),
        path: 'data/config/world.json'
    };
});

management.put('/setup/config', async (req, reply) => {
    // this endpoint rewrites world.json wholesale, and node.production: false
    // grants every player staffmodlevel 4 on the next restart - destructive
    // commands included. It is a dev convenience, not an admin API.
    if (Environment.node.production) {
        reply.status(403);
        return { error: 'Editing the config over HTTP is disabled in production.' };
    }

    const config = normalizeWorldConfig(req.body);
    saveWorldConfig(config);

    return {
        config,
        restartRequired: true
    };
});

// The kit's single player stops its world this way: loopback only, like the
// rest of the management surface, and the same path as a signal, so saves flush.
management.post('/shutdown', async (_req, reply) => {
    const accepted = requestShutdown(() => World.rebootTimer(0));
    reply.status(202);
    return { stopping: true, alreadyStopping: !accepted };
});

export async function startManagementWeb() {
    // loopback only: this server is not behind Caddy and bootstrap.sh sets no
    // host firewall, so reach it with `ssh -L 8898:localhost:8898` like the rest
    // of the fleet's admin surface
    await management.listen({ port: Environment.web.managementPort, host: '127.0.0.1' });
}
