import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 8, read back from the file.
//
// Same reason as the other *Sql tests: nothing in this repo executes any of
// it. The website calls these functions by name, the migration is applied once
// by a person at a psql prompt, and the properties that must not drift
// silently are pinned here. Several are not readback but contract - the order
// Stop blames things in, what the board lets through, that the site's polled
// read is one row - and carry their reason in the assertion.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/8_records/migration.sql');

const ROLLBACK = '\n-- rollback:';
assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');

const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

/** Every function the file defines, keyed by name, with its body. */
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

/** What the website may call, with the argument list its grant names. */
const GRANTED: [string, string][] = [
    ['record_durations', ''],
    ['record_start', 'text, int'],
    ['record_stop', 'text'],
    ['record_abandon', 'text'],
    ['record_current', 'text'],
    ['record_history', 'text, int'],
    ['record_attempt_skills', 'text, int'],
    ['record_board', 'int, int, int']
];

/** Helpers the granted functions call. Granted to nobody. */
const WITHHELD: [string, string][] = [
    ['record_presence', 'int, timestamptz'],
    ['record_stale', 'text, timestamptz, int'],
    ['record_close_stale', 'int']
];

function body(name: string): string {
    const fn = defined.get(name);
    assert.ok(fn, `accounts.${name} is defined`);
    return fn.body;
}

test('migration 8 defines exactly the granted functions and the three helpers', () => {
    assert.deepEqual([...defined.keys()].sort(), [...GRANTED, ...WITHHELD].map(([name]) => name).sort());
});

test('every function is SECURITY DEFINER with the search_path pinned', () => {
    for (const [name, { header }] of defined) {
        assert.ok(header.includes('SECURITY DEFINER'), `${name}: SECURITY DEFINER`);
        assert.ok(header.includes('SET search_path = public, pg_temp'), `${name}: search_path`);
    }
});

test('website is granted exactly eight functions, each revoked from PUBLIC first, and no helper', () => {
    const grants = [...live.matchAll(/^GRANT EXECUTE ON FUNCTION accounts\.(\w+)\(([^)]*)\) TO website;$/gm)].map(m => [m[1], m[2]]);
    assert.deepEqual(grants, GRANTED);

    for (const [name, args] of [...GRANTED, ...WITHHELD]) {
        const revoke = live.indexOf(`REVOKE ALL ON FUNCTION accounts.${name}(${args}) FROM PUBLIC;`);
        assert.notEqual(revoke, -1, `${name}: revoked from PUBLIC`);

        const grant = live.indexOf(`GRANT EXECUTE ON FUNCTION accounts.${name}(`);
        if (grant !== -1) {
            assert.ok(revoke < grant, `${name}: revoked before it is granted`);
        }
    }

    for (const [name] of WITHHELD) {
        assert.ok(!live.includes(`GRANT EXECUTE ON FUNCTION accounts.${name}(`), `${name}: a helper, granted to nobody`);
    }

    for (const grant of live.match(/^GRANT .*/gm) ?? []) {
        assert.ok(grant.includes('ON FUNCTION'), `only functions are granted: ${grant}`);
    }
});

test('no granted function returns an account id, an address or an email', () => {
    // The site identifies players by username; a leaked website credential
    // should reach nothing more through these reads than the pages show.
    for (const [name] of GRANTED) {
        const { header } = defined.get(name)!;
        const returns = header.slice(header.indexOf('RETURNS'));
        for (const forbidden of ['account_id', 'email', 'registration_ip', /\bip\b/]) {
            assert.ok(typeof forbidden === 'string' ? !returns.includes(forbidden) : !forbidden.test(returns), `${name} returns ${forbidden}`);
        }
    }
});

test('the board shows valid attempts only, from players the hiscores show', () => {
    const board = body('record_board');

    // The one clause that decides what is public. Rejected, void and
    // abandoned attempts are kept so the site can explain them to their owner,
    // and must never surface here.
    assert.ok(board.includes("WHERE ra.state = 'valid'"), 'valid only');
    assert.ok(board.includes('AND a.staffmodlevel <= 1'), 'no staff above level 1, as the hiscore views');
    assert.ok(board.includes('AND (a.banned_until IS NULL OR a.banned_until < now())'), 'no banned players, as the hiscore views');
    assert.ok(board.includes('AND ra.profile = accounts.public_profile()'), 'the profile is not the caller\'s to choose');
    assert.ok(board.includes('AND s.gained > 0'), 'nothing gained is not a record');
    assert.ok(board.includes('SELECT DISTINCT ON (ra.account_id)'), 'one row per player, their best');
    assert.ok(board.includes('LIMIT least(greatest(coalesce(p_limit, 50), 1), 100)'), 'a clamped limit');
});

test('the polled read answers every name with exactly one row', () => {
    const current = body('record_current');

    // The account page polls this. "No rows" would be indistinguishable from
    // "the read failed" by the time it reached the page, and one means "you
    // have no attempt" while the other means "we lost your attempt". Every
    // join hangs off (SELECT 1), and a GROUP BY would turn an unknown name's
    // one row into none.
    assert.ok(current.includes('FROM (SELECT 1) one'), 'anchored on a single row');
    assert.ok(!current.includes('GROUP BY'), 'no GROUP BY');
    assert.ok(!/\bJOIN public\.account a\b/.test(current.replace('LEFT JOIN public.account a', '')), 'the account join is a LEFT JOIN');
    assert.ok(current.includes('LEFT JOIN LATERAL'), 'the newest attempt is a LEFT JOIN LATERAL');
    assert.ok(current.includes('now()'), 'server_now, so the page counts down against our clock');

    // Newest by id, not by started_at: a running attempt is always the last one
    // inserted, and an id cannot be moved the way a timestamp can.
    assert.ok(current.includes('ORDER BY r.id DESC'), 'the newest attempt is the last inserted');
});

test('Start and Stop wait five seconds past a logout', () => {
    // The login server writes logged_in = 0 before it runs updateHiscores. A
    // snapshot inside that gap would read the hiscore from before the session
    // just ended, and a Start there would bank XP earned before it.
    assert.ok(body('record_presence').includes("WHEN p_logout_time > now() - interval '5 seconds' THEN 'syncing'"), 'syncing');

    for (const name of ['record_start', 'record_stop']) {
        assert.ok(body(name).includes('v_presence := accounts.record_presence(v_logged_in, v_logout_time);'), `${name} asks record_presence`);
        assert.ok(body(name).includes("IF v_presence = 'logged_in' OR v_presence = 'syncing' THEN"), `${name} refuses in the game and while syncing`);
    }
});

test('an unknown name writes nothing', () => {
    // db:check calls every write against a name nobody has; it must be safe
    // against production.
    for (const name of ['record_start', 'record_stop', 'record_abandon']) {
        const text = body(name);
        const notFound = text.indexOf('not_found');
        assert.notEqual(notFound, -1, `${name}: answers not_found`);

        for (const write of ['INSERT INTO', 'UPDATE public.', 'record_close_stale']) {
            const at = text.indexOf(write);
            if (at !== -1) {
                assert.ok(notFound < at, `${name}: resolves the name before ${write}`);
            }
        }
    }
});

test('Stop blames the server before the player', () => {
    const stop = body('record_stop');

    // A session that ended without a clean logout means the hiscore behind it
    // is whatever an autosave left - possibly long after the window. That is a
    // window we cannot vouch for, so it is void (our failure) and it is checked
    // before anything that would report the player's failure instead.
    const unclean = stop.indexOf("v_reason := 'no_clean_logout'");
    const noSession = stop.indexOf("v_reason := 'no_session'");
    const overTime = stop.indexOf("v_reason := 'over_time'");

    assert.ok(unclean !== -1 && noSession !== -1 && overTime !== -1, 'all three verdicts');
    assert.ok(unclean < noSession && noSession < overTime, 'void, then no session, then over time');
    assert.ok(stop.includes('AND s.timestamp > greatest(coalesce(v_logout_time, v_started_at), v_started_at)'), 'a login newer than both Start and the last clean logout');
});

test('the window is Start to the final logout, and the grace is the durations table\'s', () => {
    const stop = body('record_stop');

    assert.ok(stop.includes('v_elapsed := floor(extract(epoch FROM (v_logout_time - v_started_at)) * 1000)::bigint;'), 'elapsed from the logout, not the click');
    assert.ok(stop.includes('SELECT d.grace_seconds INTO v_grace FROM accounts.record_durations() d WHERE d.duration_seconds = v_duration;'), 'one source for the grace');
    assert.ok(stop.includes('IF v_elapsed > (v_duration + coalesce(v_grace, 0))::bigint * 1000 THEN'), 'over the duration plus its grace is over time');
    assert.ok(body('record_durations').includes('VALUES (300, 10);'), 'five minutes, ten seconds of grace');
});

test('the cap is twelve starts an hour, and a void attempt is free', () => {
    const start = body('record_start');
    assert.ok(start.includes("AND ra.started_at > now() - interval '1 hour'"), 'an hour');
    assert.ok(start.includes("AND ra.state <> 'void'"), 'void is our failure, so it is free');
    assert.ok(start.includes('IF v_recent >= 12 THEN'), 'twelve');
    assert.ok(start.includes("PERFORM pg_advisory_xact_lock(hashtext('record:' || v_account_id));"), 'two tabs cannot both get under it');
});

test('categories are hiscore types, read straight from the hiscore tables', () => {
    // 0 is Overall from hiscore_large, 1..21 the skills from hiscore - the
    // numbering the website's CATEGORIES speaks, so nothing converts.
    for (const name of ['record_start', 'record_stop']) {
        const text = body(name);
        assert.ok(text.includes('FROM public.hiscore_large h'), `${name}: Overall`);
        assert.ok(text.includes('AND h.type = 0'), `${name}: Overall is type 0`);
        assert.ok(text.includes('FROM public.hiscore h'), `${name}: the skills`);
        assert.ok(!/\bh\.type\s*[-+]\s*1\b/.test(text), `${name}: no conversion to stat ids`);
    }
});

test('no reaper, in any migration, touches the attempts', () => {
    // The attempts are the record book and the start cap's memory. A retention
    // rule added later would not make a page fail; it would quietly lose
    // records and hand players their starts back.
    assert.ok(!live.includes('FUNCTION accounts.reap('), 'migration 8 leaves reap() alone');

    const dir = new URL('../prisma/postgres/migrations/', import.meta.url);
    for (const name of readdirSync(dir)) {
        if (name === 'migration_lock.toml') {
            continue;
        }

        const sql = read(`../prisma/postgres/migrations/${name}/migration.sql`);
        for (const match of sql.matchAll(/CREATE OR REPLACE FUNCTION accounts\.reap\(\)/g)) {
            const reap = sql.slice(match.index, sql.indexOf('$$;', sql.indexOf('$$', match.index) + 2));
            assert.ok(!reap.includes('record_attempt'), `${name}: reap() mentions record_attempt`);
        }
    }
});

test('the rollback is all comments and drops everything the migration made', () => {
    for (const line of rollback.split('\n')) {
        assert.ok(line === '' || line.startsWith('--'), `rollback line is a comment: ${line}`);
    }

    for (const [name, args] of [...GRANTED, ...WITHHELD]) {
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${name}(${args});`), `drops ${name}`);
    }

    assert.ok(rollback.includes('-- DROP TABLE IF EXISTS "record_attempt_skill";'), 'drops record_attempt_skill');
    assert.ok(rollback.includes('-- DROP TABLE IF EXISTS "record_attempt";'), 'drops record_attempt');
});
