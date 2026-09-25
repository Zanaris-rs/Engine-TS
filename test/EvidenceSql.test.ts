import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The SQL API half of migration 4, read back from the file.
//
// EvidenceSchema.test.ts asserts the tables; this asserts the functions over
// them, and it exists for one reason: nothing in this repo executes any of it.
// The website calls these functions by name and reads their columns by hand,
// the migration is applied once by a person at a psql prompt, and the only
// thing that ever ran the file end to end was a throwaway postgres in docker.
// So the properties that must not drift silently - who may execute what, which
// columns are public, how long anything lives - are pinned here instead.
//
// What this file deliberately does not do is re-check the SQL's meaning. It is
// a readback, not a database; the proof that these functions answer correctly
// is the scratch transcript in the task report.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const migration = read('../prisma/postgres/migrations/004_evidence_and_records/migration.sql');

// The rollback block at the bottom is commented out, and it contains whole
// function definitions. Everything below the marker is prose as far as this
// file is concerned - parsing it would find a `staff_reports` with the old
// shape and a `reap` with the old rules.
const ROLLBACK = '\n-- rollback:';
const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

assert.ok(migration.includes(ROLLBACK), 'the rollback block is the boundary this file reads to');

/**
 * Every function the file defines, keyed by name, with its body.
 *
 * The header runs from `CREATE OR REPLACE FUNCTION accounts.<name>(` to the
 * first `$$` and the body from there to the closing `$$;`, which is the shape
 * every function in every migration here is written in.
 */
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

/**
 * The plan's FUNCTIONS table, in the plan's order, with the argument list each
 * one is REVOKEd and GRANTed by. The signature is the contract: the website
 * calls these positionally and its `db:check` asserts `accounts.staff_report(text,
 * int)` and friends by type, so a parameter that changes type here fails there.
 */
const API: [string, string][] = [
    ['staff_reports', 'text, timestamptz'],
    ['staff_report', 'text, int'],
    ['staff_report_input', 'text, int'],
    ['staff_report_chat', 'text, int'],
    ['staff_report_wealth', 'text, int'],
    ['staff_wealth', 'text, text, timestamptz'],
    ['staff_report_resolve', 'text, text, int, text, text'],
    ['staff_lift', 'text, text, int, text'],
    ['staff_punishment_note', 'text, int, text'],
    ['public_punishments', 'int, int'],
    ['public_economy', 'int'],
    ['public_economy_flow', 'int'],
    ['public_staff_spawns', 'int'],
    ['reap', '']
];

/** Defined here, called by the functions above, granted to nobody. */
const HELPERS: [string, string][] = [
    ['report_offender', 'int'],
    ['public_profile', '']
];

test('migration 4 defines every function in the plan, and no others', () => {
    assert.deepEqual([...defined.keys()].sort(), [...API.map(([name]) => name), ...HELPERS.map(([name]) => name)].sort());
});

test('every function is SECURITY DEFINER with the search_path pinned', () => {
    for (const [name, { header }] of defined) {
        assert.ok(header.includes('SECURITY DEFINER'), `${name}: SECURITY DEFINER`);
        assert.ok(header.includes('SET search_path = public, pg_temp'), `${name}: search_path`);
    }
});

test('every function loses the PUBLIC default, and only the API is granted to website', () => {
    for (const [name, args] of [...API, ...HELPERS]) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${name}(${args}) FROM PUBLIC;`), `REVOKE ${name}`);
    }

    // The plan's grant list, and nothing else. A helper granted by accident is
    // the one mistake in this file that a reader would not notice: it looks
    // exactly like the thirteen lines above it.
    const granted = [...live.matchAll(/^GRANT EXECUTE ON FUNCTION accounts\.(\w+)\(([^)]*)\) TO website;$/gm)].map(match => [match[1], match[2]] as [string, string]);

    assert.deepEqual(granted, API);

    for (const [name] of HELPERS) {
        assert.ok(!live.includes(`GRANT EXECUTE ON FUNCTION accounts.${name}`), `${name} is granted to nobody`);
    }

    // 12 new + staff_reports and reap, which this migration replaces and which
    // 003_message_centre and 002_website_login had already granted. The closing
    // comment counts them, and a reader checks the count rather than the list.
    assert.equal(granted.length, 14);
    assert.ok(live.includes('Fourteen GRANT statements above'), 'the closing comment counts the grants');
    assert.ok(live.includes('**thirty-two** executable functions'), 'the closing comment counts the API');
});

test('the migration grants nothing on a table, still', () => {
    for (const grant of migration.match(/^GRANT .*/gm) ?? []) {
        assert.ok(grant.includes('ON FUNCTION'), grant);
    }
});

test('every staff function re-reads the actor level from the database', () => {
    for (const [name] of API) {
        if (!name.startsWith('staff_')) {
            continue;
        }

        const { body } = defined.get(name)!;

        // A WHERE clause in the reads (which answer empty), an early return in
        // the writes. Either way the cookie decides nothing.
        assert.ok(body.includes('accounts.is_staff(p_actor)'), `${name}: is_staff`);
    }
});

test("the two verbs that re-type a password use staff_notice's compare-and-set", () => {
    for (const [name, bucket] of [
        ['staff_report_resolve', 'resolve'],
        ['staff_lift', 'lift']
    ] as const) {
        const { body } = defined.get(name)!;

        // forbidden before anything else, so a probe with somebody else's name
        // learns nothing about their password or about the id it asked for.
        assert.ok(body.indexOf("RETURN 'forbidden'") < body.indexOf('accounts.throttled'), `${name}: forbidden first`);

        // The bcrypt hash the site computed against the actor's own salt, whole.
        assert.ok(body.includes('length(p_candidate_hash) <> 60'), `${name}: 60 characters`);
        assert.ok(body.includes('v_password <> p_candidate_hash'), `${name}: compared against the stored hash`);

        // A bucket of its own, keyed on the prefixed name: ten fat-fingered
        // notices must not also lock the moderator out of signing in.
        assert.ok(body.includes(`accounts.throttled('${bucket}:' || p_actor, p_actor)`), `${name}: throttle bucket`);
        assert.ok(body.includes(`accounts.record_failure('${bucket}:' || p_actor, p_actor)`), `${name}: failure bucket`);

        assert.ok(body.includes('INSERT INTO public.staff_action'), `${name}: audited`);
    }

    assert.ok(defined.get('staff_punishment_note')!.body.includes('INSERT INTO public.staff_action'), 'staff_punishment_note: audited');
});

test("the note verb takes no password, so it takes staff_notice's hourly cap instead", () => {
    const { body } = defined.get('staff_punishment_note')!;

    // Nothing else in this function slows anybody down - no password means no
    // bad_credentials and no throttle bucket - and it writes a sentence onto a
    // page anybody can read. Twenty an hour, counted off its own audit rows, so
    // the limiter and the record of what it limited are one table.
    assert.ok(body.includes("s.action = 'staff_punishment_note'"), 'counted off its own audit rows');
    assert.ok(body.includes("s.created_at > now() - interval '1 hour'"), 'per hour');
    assert.ok(body.includes("IF v_hour >= 20 THEN RETURN 'rate_limited'; END IF;"), 'twenty, then rate_limited');

    // The cap is the actor's, so it needs the actor id, so it must come after
    // the lookup and before the punishment is found - a rate-limited call must
    // not leak whether an id exists.
    assert.ok(body.indexOf('v_hour >= 20') > body.indexOf('INTO v_actor_id'), 'after the actor lookup');
    assert.ok(body.indexOf('v_hour >= 20') < body.indexOf("RETURN 'not_found'"), 'before the punishment lookup');
});

test('dismissing a report deletes its evidence in the same statement', () => {
    const { body } = defined.get('staff_report_resolve')!;

    assert.ok(body.includes("p_resolution = 'dismissed'"), 'the dismissed branch');
    assert.ok(body.includes('DELETE FROM public.report_input WHERE report_uuid = v_uuid'), 'report_input');
    assert.ok(body.includes('DELETE FROM public.report_chat WHERE report_uuid = v_uuid'), 'report_chat');

    // Nothing else in the file deletes evidence except the reaper.
    for (const [name, { body: other }] of defined) {
        if (name === 'staff_report_resolve' || name === 'reap') {
            continue;
        }

        assert.ok(!other.includes('DELETE FROM'), `${name} deletes nothing`);
    }
});

test('the evidence window is thirty minutes before the report and fifteen after', () => {
    // The same numbers as LoggerServer's CHAT_BEFORE_MS and World's
    // REPORT_TRACK_MS. The report page draws its axis from window_from and
    // window_to, so a disagreement here is a timeline that does not contain
    // the capture it is plotting.
    for (const name of ['staff_report', 'staff_report_wealth']) {
        const { body } = defined.get(name)!;

        assert.ok(body.includes("r.timestamp - interval '30 minutes'"), `${name}: 30 minutes before`);
        assert.ok(body.includes("r.timestamp + interval '15 minutes'"), `${name}: 15 minutes after`);
    }
});

test('the reaper keeps wealth seven days and evidence thirty, and never touches chat', () => {
    const { body } = defined.get('reap')!;

    // 002_website_login's two rules, unchanged.
    assert.ok(body.includes("DELETE FROM public.signup_attempt WHERE created_at < now() - interval '24 hours'"), 'signup_attempt: 24 hours');
    assert.ok(body.includes("DELETE FROM public.login_attempt WHERE created_at < now() - interval '1 hour'"), 'login_attempt: 1 hour');

    assert.ok(body.includes("DELETE FROM public.session_wealth WHERE timestamp < now() - interval '7 days'"), 'session_wealth: 7 days');

    for (const table of ['report_input', 'report_chat']) {
        assert.ok(body.includes(`DELETE FROM public.${table}`), `${table}: reaped`);
    }

    assert.equal(body.match(/interval '30 days'/g)?.length, 4, 'thirty days, twice per evidence table');
    assert.ok(body.includes("r.resolution IS DISTINCT FROM 'dismissed'"), 'dismissed evidence goes on the next pass too');

    // Chat is swept by its own writer, the friend server, an hour after it was
    // said - on three backends, one of which has no pg_cron. A second rule
    // here is a rule that ends up disagreeing with itself.
    for (const table of ['public_chat', 'private_chat']) {
        assert.ok(!body.includes(table), `reap() has no rule for ${table}`);
    }
});

test('both notes are measured after trimming, on the value that gets stored', () => {
    const resolve = defined.get('staff_report_resolve')!.body;

    // A paste that arrives with a screenful of whitespace on the end is not a
    // longer note, and the length that is refused has to be the length that
    // would have been kept.
    assert.ok(resolve.includes("v_note := nullif(btrim(coalesce(p_note, '')), '');"), 'resolve trims first');
    assert.ok(resolve.includes('length(v_note) > 1000'), 'resolve measures the trimmed note');
    assert.ok(!resolve.includes('length(p_note)'), 'resolve never measures the raw argument');
    assert.ok(resolve.includes('staff_note = v_note'), 'and stores what it measured');

    for (const name of ['staff_lift', 'staff_punishment_note']) {
        const body = defined.get(name)!.body;

        assert.ok(body.includes('length(v_note) > 120'), `${name}: the public cap, trimmed`);
        assert.ok(!body.includes('length(p_note)'), `${name}: never measures the raw argument`);
    }
});

test('the offender session on a report has to belong to the offender', () => {
    const { body } = defined.get('staff_report')!;

    // report.offender_session_uuid is written by a world that guessed, or by
    // the login server's newest-session lookup. A uuid that turns out to be
    // somebody else's would put a stranger's world on the page and hand their
    // address to same_ip_as_reporter, which is the one thing this function
    // exists to be careful with.
    assert.ok(/s\.uuid = r\.offender_session_uuid\s+AND \(offender\.id IS NULL OR s\.account_id = offender\.id\)/.test(body), 'the named session is checked against the offender');
    // Both branches of the LATERAL, and it is the same test in each: the
    // third occurrence in this function is offender_logins_24h, which counts
    // the offender's own logins and always did.
    const lateral = body.slice(body.indexOf('LEFT JOIN LATERAL'), body.indexOf(') offender_session ON true'));
    assert.equal(lateral.match(/s\.account_id = offender\.id/g)?.length, 2, 'both branches check it');
});

test("every read of a player's sessions is pinned to one profile", () => {
    // One database serves every profile a fleet runs, and an account with a
    // character on main and one on beta is the same `account_id` on both. A
    // session lookup with no profile in it is therefore both a sequential scan
    // (002_website_login's only index on `session` leads with profile) and an
    // answer that can come from the wrong world - a beta trade quoted inside
    // the window of a report filed on main.
    //
    // The report functions take it from the reporter's own session, which is a
    // fact about the report. staff_wealth has no such fact to read - a username
    // and a date is all it is given - so it takes the constant.
    const report = defined.get('staff_report')!.body;

    // the offender-session fallback and the 24-hour login count, both of which
    // look a player up by account_id alone
    assert.equal(report.match(/reporter_session\.profile IS NULL OR s\.profile = reporter_session\.profile/g)?.length, 2, 'staff_report pins both session reads');

    const wealth = defined.get('staff_report_wealth')!.body;

    assert.ok(wealth.includes('JOIN public.session rs ON rs.uuid = r.session_uuid'), 'staff_report_wealth reads the reporter session');
    assert.ok(wealth.includes('s.profile = rs.profile'), 'staff_report_wealth pins the offender to it');

    // the constant, not the actor's newest session: the same query must not
    // answer differently depending on which world a moderator last logged into
    const search = defined.get('staff_wealth')!.body;

    assert.ok(search.includes('s.profile = accounts.public_profile()'), 'staff_wealth pins the constant');
});

test('the chat transcript says how much of it there is', () => {
    const { header, body } = defined.get('staff_report_chat')!;

    // A window function is computed after WHERE and before ORDER BY and LIMIT,
    // so this is the count of the whole match and the LIMIT then takes a page
    // of it. Without it the page shows two thousand lines as though they were
    // all of them, which is a transcript that lies rather than one that is cut.
    assert.ok(header.includes('total int'), 'the total is a column');
    assert.ok(body.includes('(count(*) OVER ())::int'), 'counted before the limit');
    assert.ok(body.includes('LIMIT 2000'), 'and the page is two thousand');
});

test('the staff wealth search never claims more than the seven days the rows live', () => {
    const { body } = defined.get('staff_wealth')!;

    assert.ok(body.includes("greatest(coalesce(p_since, now() - interval '7 days'),"), 'p_since is raised to the retention');
    assert.ok(body.includes("now() - interval '7 days')"), 'the floor is the retention');
});

test('no public function returns an issuer, an account or an address', () => {
    // The decision that a punishment is public and the moderator who issued it
    // is not lives in these select lists. `/bans` cannot ask for an issuer
    // because there is no argument that would carry the question, and the
    // column is not in the answer either.
    const forbidden = ['issued_by_account_id', 'lifted_by_account_id', 'account_id', 'staff_account_id', 'target_account_id', 'registration_ip', /\bip\b/];

    for (const [name] of API) {
        if (!name.startsWith('public_')) {
            continue;
        }

        const { body } = defined.get(name)!;

        for (const needle of forbidden) {
            const found = typeof needle === 'string' ? body.includes(needle) : needle.test(body);
            assert.ok(!found, `${name} mentions ${needle}`);
        }

        // And nothing joins to account, which is the only table that could
        // turn an id back into a name.
        assert.ok(!body.includes('public.account'), `${name} does not read account`);
    }

    // The census and the spawn list name nobody at all.
    for (const name of ['public_economy', 'public_economy_flow', 'public_staff_spawns']) {
        assert.ok(!defined.get(name)!.header.includes('username'), `${name} returns no name`);
    }

    // The one name the public record does carry is the punished account's own,
    // which is the whole point of it.
    assert.ok(defined.get('public_punishments')!.body.includes('p.username'), 'public_punishments names the punished account');
});

test('the public record is newest first, and honours a limit up to a hundred', () => {
    const punishments = defined.get('public_punishments')!.body;

    assert.ok(punishments.includes('ORDER BY p.issued_at DESC, p.id DESC'), 'newest first');
    // /bans asks for its page size plus one to learn whether there is a next
    // page, so the limit is the caller's up to a ceiling, not a fixed page.
    assert.ok(punishments.includes('LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)'), 'up to 100');
    // Both ends clamped. An OFFSET is not free - postgres walks and discards
    // every row it skips - and /bans is unauthenticated, so `?page=500000`
    // would be a full index scan of a growing table, once per distinct page
    // number, cached separately by ISR.
    assert.ok(punishments.includes('OFFSET least(greatest(coalesce(p_offset, 0), 0), 100000)'), 'paged, and the offset is capped');

    assert.ok(defined.get('public_staff_spawns')!.body.includes('ORDER BY ss.created_at DESC, ss.id DESC'), 'spawns newest first');
});

test('the census functions read one profile, and the caller cannot choose it', () => {
    for (const name of ['public_economy', 'public_economy_flow']) {
        const { body } = defined.get(name)!;

        assert.ok(body.includes('profile = accounts.public_profile()'), `${name}: one profile`);
        assert.ok(body.includes('least(greatest(coalesce(p_days, 30), 1), 90)'), `${name}: bounded window`);
    }

    // Deliberately not current_setting('app.public_profile'): a GUC is settable
    // for the session by whoever holds the connection, so `website` could point
    // the public page at any profile it liked by sending one SET first. The
    // whole point of these functions is that the caller does not choose what is
    // public, and a knob the caller can turn is the opposite of that.
    // The phrase survives in the comment on public_profile(), which is where
    // the reasoning lives; what must not survive is a call in a body.
    for (const [name, { body }] of defined) {
        assert.ok(!body.includes('current_setting'), `${name} reads no session setting`);
    }
    assert.ok(defined.get('public_profile')!.body.includes("SELECT 'main'::text;"), 'a constant');
    assert.ok(!live.includes('GRANT EXECUTE ON FUNCTION accounts.public_profile'), 'granted to nobody');
});

test('the rollback block is commented, and undoes exactly what the file did', () => {
    for (const line of rollback.split('\n')) {
        assert.ok(line === '' || line.startsWith('--'), `not commented: ${line}`);
    }

    for (const [name, args] of [...API, ...HELPERS]) {
        // reap and staff_reports are restored to their previous bodies rather
        // than dropped - they existed before this migration.
        if (name === 'reap' || name === 'staff_reports') {
            assert.ok(rollback.includes(`-- CREATE OR REPLACE FUNCTION accounts.${name}(`), `${name} is restored, not dropped`);
            continue;
        }

        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${name}(${args});`), `DROP ${name}`);
    }

    for (const table of ['report_input', 'report_chat', 'punishment', 'staff_spawn', 'economy_snapshot', 'economy_flow']) {
        assert.ok(rollback.includes(`-- DROP TABLE IF EXISTS public.${table};`), `DROP TABLE ${table}`);
    }

    for (const column of ['uuid', 'offender_account_id', 'offender_session_uuid', 'offender_coord', 'resolved_at', 'resolution', 'resolved_by_account_id', 'staff_note']) {
        assert.ok(rollback.includes(`-- ALTER TABLE public.report DROP COLUMN IF EXISTS ${column};`), `DROP COLUMN report.${column}`);
    }
});
