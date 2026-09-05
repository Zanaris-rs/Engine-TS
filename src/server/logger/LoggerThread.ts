import { parentPort } from 'worker_threads';

import LoggerClient from '#/server/logger/LoggerClient.js';
import type { EvidenceMessage } from '#/server/logger/index.d.js';
import Environment from '#/util/Environment.js';

const client = new LoggerClient();

if (!parentPort) throw new Error('This file must be run as a worker thread.');

/**
 * Evidence that could not be sent, waiting for the logger server to come back.
 *
 * Only evidence is held. A session log or a wealth event is one row among
 * thousands and a lost batch costs nothing anybody will look for; a chunk of a
 * macro report is a piece of the only record of what somebody was doing, and
 * the logger server restarting for ten seconds during a deploy should not
 * silently take a bite out of it.
 *
 * Held, but bounded, and by the two things that can go wrong here: a logger
 * that is down for a long time (the TTL) and a world that keeps producing
 * evidence while it is (the cap, oldest dropped first). Neither can turn a
 * disconnected logger into a memory leak in the world process.
 */
const MAX_PENDING = 32;
const PENDING_TTL = 5 * 60 * 1000;
const RETRY_INTERVAL = 15_000;

const pending: Map<string, { message: EvidenceMessage; firstTried: number }> = new Map();

/** One key per thing that can be written once: a chunk, or the end of a window. */
function evidenceKey(message: EvidenceMessage): string {
    return message.type === 'report_evidence' ? `${message.report_uuid}:${message.seq}` : `${message.report_uuid}:end`;
}

async function sendEvidence(message: EvidenceMessage): Promise<void> {
    const key = evidenceKey(message);

    if (await client.evidence(message)) {
        pending.delete(key);
        return;
    }

    if (!pending.has(key)) {
        pending.set(key, { message, firstTried: Date.now() });

        // Map iterates in insertion order, so the first key is the oldest
        while (pending.size > MAX_PENDING) {
            const oldest = pending.keys().next();

            if (oldest.done) {
                break;
            }

            pending.delete(oldest.value);
        }
    }
}

// the retry loop has no caller to catch for it, so it catches for itself
setInterval(async () => {
    try {
        if (pending.size === 0) {
            return;
        }

        const now = Date.now();

        for (const [key, held] of pending) {
            if (now - held.firstTried >= PENDING_TTL) {
                pending.delete(key);
                continue;
            }

            if (await client.evidence(held.message)) {
                pending.delete(key);
            } else {
                // the socket is still down; the rest of the queue will not fare
                // any better this time round
                break;
            }
        }
    } catch (err) {
        console.error(err);
    }
}, RETRY_INTERVAL).unref();

parentPort.on('message', async msg => {
    try {
        if (!parentPort) throw new Error('This file must be run as a worker thread.');
        await handleRequests(parentPort, msg);
    } catch (err) {
        console.error(err);
    }
});

client.onMessage((opcode, data) => {
    parentPort!.postMessage({ opcode, data });
});

type ParentPort = {
    postMessage: (msg: any) => void;
};

async function handleRequests(_parentPort: ParentPort, msg: any) {
    const { type } = msg;

    switch (type) {
        case 'session_log': {
            if (Environment.logger.enabled) {
                const { logs } = msg;
                await client.sessionLog(logs);
            }
            break;
        }
        case 'wealth_event': {
            if (Environment.logger.enabled) {
                const { events } = msg;
                await client.wealthEvent(events);
            }
            break;
        }
        // no 'report' case: Report Abuse goes to the login thread now. This
        // one dropped every report on a fleet with the logger disabled, which
        // is every fleet we run, while the player was told it had been
        // received. LoggerServer still handles the opcode for an older world.
        //
        // no 'input_track' case either: it wrote `input_report`, which nothing
        // has ever read. Report evidence is the two messages below.
        case 'report_evidence':
        case 'evidence_end': {
            if (Environment.logger.enabled) {
                await sendEvidence(msg as EvidenceMessage);
            }
            break;
        }
        // todo: store session's packet traffic for analysis
        default:
            console.error('Unknown message type: ' + msg.type);
            break;
    }
}
