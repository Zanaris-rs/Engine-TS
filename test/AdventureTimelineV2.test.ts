import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 15, read back from the file. Its behaviour is rehearsed against a
// real postgres outside this repo (tests/migration-015.sql); what must not
// drift silently is pinned here. A gz shows nothing a log does not already
// show anyone - twenty minutes late, hidden categories hidden - and the new
// timeline narrows 013's, never widens it.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/015_adventure_timeline_v2/migration.sql');
const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

const ROLLBACK = '\n-- rollback:';
const MARKER = '-- === functions ===';
assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');

const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

function functions(sql: string): Map<string, { header: string; body: string }> {
    const found = new Map<string, { header: string; body: string }>();

    for (const match of sql.matchAll(/CREATE OR REPLACE FUNCTION accounts\.(\w+)\(/g)) {
        const start = match.index;
        const open = sql.indexOf('$$', start);
        const close = sql.indexOf('$$;', open + 2);

        assert.notEqual(open, -1, `${match[1]}: no body`);
        assert.notEqual(close, -1, `${match[1]}: no end of body`);

        found.set(match[1], { header: sql.slice(start, open), body: sql.slice(open + 2, close) });
    }

    return found;
}

const defined = functions(live);
const fn = (name: string) => {
    const found = defined.get(name);
    assert.ok(found, name);
    return found;
};

const GRANTED = [
    'adventure_timeline(text, text, timestamptz, int, int, int, int)',
    'adventure_pinned(text, text)',
    'adventure_log_records(text)',
    'adventure_gz_give(text, int)',
    'adventure_gz_take(text, int[])',
    'adventure_update_edit(text, int, text)',
    'adventure_log_pin(text, int)'
];

const TIMELINE_COLUMNS = 'RETURNS TABLE (kind text, rank int, id int, at timestamptz, category int, body text, reply_count int,\n               edited_at timestamptz, gz_count int, gz_names text[], viewer_gz boolean)';

test('migration 15 defines the seven functions and nothing else', () => {
    assert.deepEqual([...defined.keys()].sort(), ['adventure_gz_give', 'adventure_gz_take', 'adventure_log_pin', 'adventure_log_records', 'adventure_pinned', 'adventure_timeline', 'adventure_update_edit']);
    assert.ok(!live.slice(0, live.indexOf(MARKER)).includes('CREATE OR REPLACE FUNCTION'), 'no functions above the marker');
});

test('each is SECURITY DEFINER with search_path pinned, and every one is granted to website', () => {
    for (const [name, { header }] of defined) {
        assert.ok(header.includes('SECURITY DEFINER SET search_path = public, pg_temp'), name);
    }
    for (const signature of GRANTED) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`), `revoke ${signature}`);
        assert.ok(live.includes(`GRANT EXECUTE ON FUNCTION accounts.${signature} TO website;`), `grant ${signature}`);
    }
    assert.equal(live.match(/GRANT EXECUTE ON FUNCTION/g)?.length, GRANTED.length, 'seven grants, 77 -> 84');
});

test('the website codes against these columns', () => {
    const timeline = fn('adventure_timeline');
    assert.ok(
        timeline.header.includes(
            '(p_name text, p_viewer text,\n                                                       p_before_at timestamptz, p_before_rank int, p_before_id int,\n                                                       p_limit int, p_show int)'
        ),
        'timeline arguments'
    );
    assert.ok(timeline.header.includes(TIMELINE_COLUMNS), 'timeline columns');
    assert.ok(fn('adventure_pinned').header.includes(TIMELINE_COLUMNS), 'pinned is in the timeline shape');
    assert.ok(fn('adventure_log_records').header.includes('RETURNS TABLE (duration_seconds int, gained bigint, elapsed_ms bigint, achieved_at timestamptz, rank int)'), 'records columns');
});

test("013's six-argument timeline is left alone", () => {
    assert.ok(!migration.includes('DROP FUNCTION IF EXISTS accounts.adventure_timeline(text, text, timestamptz, int, int, int);'), 'not dropped');
    assert.ok(!live.includes('adventure_timeline(text, text, timestamptz, int, int, int)'), 'not touched');
});

test("the timeline keeps 013's rules and narrows them with p_show", () => {
    const body = fn('adventure_timeline').body;
    assert.ok(body.includes("(log.is_owner OR e.occurred_at <= now() - interval '20 minutes')"), 'twenty minutes, but not for the owner');
    assert.ok(body.includes('AND (log.hidden & (1 << e.category)) = 0'), 'hidden categories still hidden');
    assert.ok(body.includes('AND (log.show & (1 << e.category)) <> 0'), 'p_show for adventures');
    assert.ok(body.includes('AND (log.show & 256) <> 0'), 'bit 8 for updates');
    assert.ok(body.includes('coalesce(p_show, 511) AS show'), 'NULL shows everything');
    assert.ok(body.includes('AND u.id IS DISTINCT FROM log.pinned'), 'the pinned update is not in the stream');
    assert.ok(body.includes('least(greatest(coalesce(p_limit, 30), 1), 50) + 1'), "013's page clamp");
});

test('gz on the timeline leaves out banned givers and givers the owner blocked', () => {
    const body = fn('adventure_timeline').body;
    assert.ok(body.includes("WHERE s.kind = 'event' AND gz.event_id = s.id"), 'only adventures carry gz');
    assert.ok(body.includes('(ga.banned_until IS NULL OR ga.banned_until <= now())'), 'no banned givers');
    assert.ok(body.includes('b.owner_account_id = log.id AND b.blocked_account_id = gz.account_id'), 'no blocked givers');
    assert.ok(body.includes('(array_agg(ga.username ORDER BY gz.created_at DESC, ga.username))[1:50]'), 'the newest fifty names');
});

test('a gz can only be given to what anyone but the owner can see', () => {
    const body = fn('adventure_gz_give').body;
    assert.ok(body.includes('accounts.adventure_author(p_username, false)'), 'a mute does not stop a gz');
    assert.ok(body.includes('e.profile = accounts.public_profile()'), 'the public profile');
    assert.ok(body.includes("e.occurred_at <= now() - interval '20 minutes'"), 'twenty minutes, for everyone');
    assert.ok(body.includes('(coalesce(p.hidden_categories, 0) & (1 << e.category)) = 0'), 'not a hidden category');
    assert.ok(body.includes("RETURN 'self'"), 'not your own');
    assert.ok(body.includes("RETURN 'blocked'"), 'not when blocked');
    assert.ok(body.includes("interval '1 hour') >= 300"), '300 an hour');
    assert.ok(body.includes("pg_advisory_xact_lock(hashtext('adventure_gz:' || v_author.account_id))"), 'counted under a lock');
});

test('edits follow the posting rules; pins only point at your own shown updates', () => {
    const edit = fn('adventure_update_edit').body;
    assert.ok(edit.includes('accounts.adventure_author(p_username, true)'), 'a mute stops an edit');
    assert.ok(edit.includes('accounts.adventure_text(p_body, 2000, false)'), 'the text rules of a post');
    assert.ok(edit.includes('u.deleted_at IS NULL AND u.staff_hidden_at IS NULL'), 'not a deleted or hidden update');
    assert.ok(edit.includes('IF v_body <> v_old THEN'), 'the same text leaves edited_at alone');

    const pin = fn('adventure_log_pin').body;
    assert.ok(pin.includes('u.account_id = v_author.account_id'), 'your own');
    assert.ok(pin.includes('u.deleted_at IS NULL AND u.staff_hidden_at IS NULL'), 'shown');

    const pinned = fn('adventure_pinned').body;
    assert.ok(pinned.includes('u.account_id = a.id'), "the owner's own update");
    assert.ok(pinned.includes('u.deleted_at IS NULL AND u.staff_hidden_at IS NULL'), 'still shown');
});

test('records rank as record_board ranks, on the Overall board', () => {
    const body = fn('adventure_log_records').body;
    for (const rule of [
        "ra.state = 'valid'",
        'ra.profile = accounts.public_profile()',
        's.category = 0',
        's.gained > 0',
        'a.staffmodlevel <= 1',
        '(a.banned_until IS NULL OR a.banned_until < now())',
        'ORDER BY best.gained DESC, best.achieved_at ASC, best.attempt_id ASC'
    ]) {
        assert.ok(body.includes(rule), rule);
    }
});

test('the rollback undoes everything, and the schemas agree', () => {
    for (const name of defined.keys()) {
        assert.ok(rollback.includes(`DROP FUNCTION IF EXISTS accounts.${name}(`), `rollback drops ${name}`);
    }
    assert.ok(rollback.includes('DROP TABLE IF EXISTS "adventure_gz";'), 'rollback drops the table');
    assert.ok(rollback.includes('DROP COLUMN IF EXISTS "pinned_update_id"'), 'rollback drops pinned_update_id');
    assert.ok(rollback.includes('DROP COLUMN IF EXISTS "edited_at"'), 'rollback drops edited_at');

    for (const [name, schema] of Object.entries(schemas)) {
        assert.ok(schema.includes('model adventure_gz {'), `${name}: adventure_gz`);
        assert.match(schema, /model adventure_update \{[^}]*edited_at\s+DateTime\?/, `${name}: edited_at`);
        assert.match(schema, /model adventure_log_profile \{[^}]*pinned_update_id\s+Int\?/, `${name}: pinned_update_id`);
    }
});
