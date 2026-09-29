import { CoordGrid } from '#/engine/CoordGrid.js';
import { printError } from '#/util/Logger.js';

/**
 * A Report Abuse, on its way to a Discord channel.
 *
 * The login server owns the `report` table and is the one process that sees
 * every report from every world, so it is the one that tells staff. The row is
 * written first and the webhook fires after: Discord is a notification, never
 * the record, and a Discord outage must not cost a report.
 *
 * The URL is a secret - anyone holding it can post to the channel - so it
 * comes from the environment as DISCORD_REPORT_WEBHOOK_URL, exactly as
 * DATABASE_URL does, and never from world.json (see getDatabaseUrl for why:
 * the setup UI round-trips that file to disk).
 */

/** `ReportAbuseReason`, in enum order, as the client's report screen words it. */
export const REASON_NAMES: readonly string[] = [
    'Offensive language',
    'Item scamming',
    'Password scamming',
    'Bug abuse',
    'Staff impersonation',
    'Account sharing',
    'Macroing',
    'Multi logging',
    'Encouraging others to break rules',
    'Misuse of customer support',
    'Advertising a website',
    'Real world trading'
];

export interface ReportNotice {
    /** The reporter's username, or null when the account could not be read. */
    reporter: string | null;
    offender: string;
    reason: number;
    world: number | null;
    /** Where the reporter stood, packed as the world packs it. */
    coord: number;
    /** Where the offender stood, if they were on the reporter's world. */
    offenderCoord: number | null;
    reportedAt: Date;
    /** The evidence key, when input was captured. */
    uuid: string | null;
}

interface EmbedField {
    name: string;
    value: string;
    inline?: boolean;
}

export interface WebhookPayload {
    embeds: {
        title: string;
        url?: string;
        color: number;
        fields: EmbedField[];
        timestamp: string;
    }[];
}

/** How long a webhook call may take before it is abandoned. Reports arrive on a socket handler; nothing should wait on Discord. */
const TIMEOUT_MS = 10000;

/** Discord's embed colour: a muted red, so a report stands out from chatter. */
const COLOUR = 0xc0392b;

/**
 * Usernames are validated to letters, digits, spaces and underscores, but an
 * underscore is markdown to Discord, and this is the one place the name is
 * rendered by something other than the game client.
 */
function escapeMarkdown(text: string): string {
    return text.replace(/[\\*_~`|>]/g, c => '\\' + c);
}

function place(coord: number): string {
    const { level, x, z } = CoordGrid.unpackCoord(coord);
    return `${x}, ${z}, level ${level}`;
}

export function reportPayload(notice: ReportNotice, inboxUrl?: string): WebhookPayload {
    const reasonName = REASON_NAMES[notice.reason] ?? `Unknown reason (${notice.reason})`;

    const fields: EmbedField[] = [
        { name: 'Offender', value: escapeMarkdown(notice.offender), inline: true },
        { name: 'Reporter', value: notice.reporter === null ? 'unknown' : escapeMarkdown(notice.reporter), inline: true },
        { name: 'World', value: notice.world === null ? 'unknown' : String(notice.world), inline: true },
        { name: 'Reported from', value: place(notice.coord), inline: true },
        { name: 'Offender seen at', value: notice.offenderCoord === null ? 'not online here' : place(notice.offenderCoord), inline: true },
        { name: 'Evidence', value: notice.uuid === null ? 'none' : `captured (${notice.uuid})`, inline: true }
    ];

    return {
        embeds: [
            {
                title: reasonName,
                ...(inboxUrl ? { url: inboxUrl } : {}),
                color: COLOUR,
                fields,
                timestamp: notice.reportedAt.toISOString()
            }
        ]
    };
}

/**
 * Only a Discord webhook. The value is a secret pasted by a person into a
 * secrets file, and a typo there should mean "no notifications", not "post
 * every report to whatever host the typo named".
 */
const WEBHOOK_PATTERN = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export function reportWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = env.DISCORD_REPORT_WEBHOOK_URL?.trim();

    if (!raw) {
        return null;
    }

    if (!WEBHOOK_PATTERN.test(raw)) {
        printError('DISCORD_REPORT_WEBHOOK_URL is set but is not a Discord webhook URL; report notifications are off');
        return null;
    }

    return raw;
}

/**
 * Posts one report. Never throws and never blocks the caller's work: a failed
 * notification is logged and the report stays in the table for the staff
 * inbox to show.
 */
export async function postReport(url: string, notice: ReportNotice, inboxUrl?: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(reportPayload(notice, inboxUrl)),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });

        if (!res.ok) {
            printError(`Discord report webhook answered ${res.status}; the report is in the table but was not announced`);
            return false;
        }

        return true;
    } catch (err) {
        printError(`Discord report webhook failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
