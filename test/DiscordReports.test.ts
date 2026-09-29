import assert from 'node:assert/strict';
import test from 'node:test';

import { CoordGrid } from '#/engine/CoordGrid.js';
import { postReport, REASON_NAMES, reportPayload, reportWebhookUrl, type ReportNotice } from '#/server/login/DiscordReports.js';

const notice: ReportNotice = {
    reporter: 'zanaris',
    offender: 'somebotter',
    reason: 6,
    world: 1,
    coord: CoordGrid.packCoord(0, 3222, 3218),
    offenderCoord: CoordGrid.packCoord(1, 3200, 3200),
    reportedAt: new Date('2026-09-25T10:00:00.000Z'),
    uuid: 'abc-123'
};

test('every ReportAbuseReason has a name, in enum order', () => {
    assert.equal(REASON_NAMES.length, 12);
    assert.equal(REASON_NAMES[0], 'Offensive language');
    assert.equal(REASON_NAMES[6], 'Macroing');
    assert.equal(REASON_NAMES[11], 'Real world trading');
});

test('the payload is one embed with the facts staff need', () => {
    const payload = reportPayload(notice, 'https://example.test/staff/reports');
    assert.equal(payload.embeds.length, 1);

    const embed = payload.embeds[0];
    assert.equal(embed.title, 'Macroing');
    assert.equal(embed.url, 'https://example.test/staff/reports');
    assert.equal(embed.timestamp, '2026-09-25T10:00:00.000Z');

    const fields = Object.fromEntries(embed.fields.map(f => [f.name, f.value]));
    assert.equal(fields.Reporter, 'zanaris');
    assert.equal(fields.Offender, 'somebotter');
    assert.equal(fields.World, '1');
    assert.equal(fields['Reported from'], '3222, 3218, level 0');
    assert.equal(fields['Offender seen at'], '3200, 3200, level 1');
    assert.equal(fields.Evidence, 'captured (abc-123)');
});

test('unknowns are spelled out rather than left blank', () => {
    const payload = reportPayload({ ...notice, reporter: null, world: null, offenderCoord: null, uuid: null, reason: 99 });
    const embed = payload.embeds[0];
    assert.equal(embed.title, 'Unknown reason (99)');
    assert.equal(embed.url, undefined);

    const fields = Object.fromEntries(embed.fields.map(f => [f.name, f.value]));
    assert.equal(fields.Reporter, 'unknown');
    assert.equal(fields.World, 'unknown');
    assert.equal(fields['Offender seen at'], 'not online here');
    assert.equal(fields.Evidence, 'none');
});

test('names are escaped so a username cannot format the embed', () => {
    const payload = reportPayload({ ...notice, offender: '_under*score_' });
    const fields = Object.fromEntries(payload.embeds[0].fields.map(f => [f.name, f.value]));
    assert.equal(fields.Offender, '\\_under\\*score\\_');
});

test('postReport sends JSON to the webhook and reports success', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(null, { status: 204 });
    };

    const ok = await postReport('https://discord.com/api/webhooks/1/abc', notice, undefined, fetchImpl as typeof fetch);
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://discord.com/api/webhooks/1/abc');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], 'application/json');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.embeds[0].title, 'Macroing');
    assert.ok(calls[0].init.signal instanceof AbortSignal, 'the request is bounded by a timeout');
});

test('postReport never throws: a rejected fetch or a bad status is false', async () => {
    const rejects = async () => {
        throw new Error('ECONNRESET');
    };
    assert.equal(await postReport('https://discord.com/api/webhooks/1/abc', notice, undefined, rejects as unknown as typeof fetch), false);

    const rateLimited = async () => new Response('{"retry_after": 1}', { status: 429 });
    assert.equal(await postReport('https://discord.com/api/webhooks/1/abc', notice, undefined, rateLimited as unknown as typeof fetch), false);
});

test('reportWebhookUrl accepts only a Discord webhook URL', () => {
    assert.equal(reportWebhookUrl({}), null);
    assert.equal(reportWebhookUrl({ DISCORD_REPORT_WEBHOOK_URL: '' }), null);
    assert.equal(reportWebhookUrl({ DISCORD_REPORT_WEBHOOK_URL: 'http://evil.test/x' }), null);
    assert.equal(reportWebhookUrl({ DISCORD_REPORT_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }), 'https://discord.com/api/webhooks/1/abc');
    assert.equal(reportWebhookUrl({ DISCORD_REPORT_WEBHOOK_URL: ' https://discordapp.com/api/webhooks/1/abc\n' }), 'https://discordapp.com/api/webhooks/1/abc');
});
