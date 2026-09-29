import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 18, read back from the file, and its columns in all six places.
// Its behaviour is rehearsed against a real postgres outside this repo
// (tests/before-018.sql and tests/after-018.sql for the move, on an upgrade
// from 017, and tests/migration-018.sql); what must not drift silently is
// pinned here: which functions the website may call and which are gone, the
// result columns it reads, the move of the headline into page 1, the page's
// colour and effect, the mute rule, the two masks, the 200-character limits
// and what a staff "hide" on a log now blanks.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function modelBody(schema: string, model: string): string {
    const start = schema.indexOf(`\nmodel ${model} {`);
    assert.notEqual(start, -1, `model ${model}`);
    const body = schema.slice(start);
    return body.slice(0, body.indexOf('\n}'));
}

const migration = read('../prisma/postgres/migrations/018_adventure_community/migration.sql');
// Every migration before this one, by name, for what the website could
// already call and for the functions this one replaces.
const earlierNames = readdirSync(new URL('../prisma/postgres/migrations', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{3}_/.test(entry.name) && entry.name < '018_')
    .map(entry => entry.name)
    .sort();
const earlier = new Map(earlierNames.map(name => [name, read(`../prisma/postgres/migrations/${name}/migration.sql`)]));
const mysqlMigration = read('../prisma/multiworld/migrations/20260928000000_adventure_community/migration.sql');
const sqliteBaseline = read('../prisma/singleworld/migrations/20251229170623_clean/migration.sql');
const types = read('../src/db/types.ts');
const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

const ROLLBACK = '\n-- rollback:';
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

// The functions the `website` role may run after a migration's statements,
// replayed line by line: a GRANT to it adds a signature, and a REVOKE from it
// or a DROP takes one away (a dropped function loses its grants).
function replay(sql: string, granted: ReadonlySet<string>): Set<string> {
    const after = new Set(granted);
    for (const [, verb, signature, role] of sql.matchAll(/^(GRANT|REVOKE|DROP) [A-Z ]*?accounts\.(.+?)(?: (?:TO|FROM) (\w+))?;$/gm)) {
        if (verb === 'GRANT' && role === 'website') {
            after.add(signature);
        } else if ((verb === 'REVOKE' && role === 'website') || verb === 'DROP') {
            after.delete(signature);
        }
    }
    return after;
}

const defined = functions(live);
const fn = (name: string) => {
    const found = defined.get(name);
    assert.ok(found, name);
    return found;
};
// A function as an earlier migration last made it.
const before = (file: string, name: string) => {
    const sql = earlier.get(file);
    assert.ok(sql, file);
    const found = functions(sql.slice(0, sql.indexOf(ROLLBACK))).get(name);
    assert.ok(found, `${file}: ${name}`);
    return found;
};

const GRANTED = [
    'adventure_log(text, text)',
    'adventure_log_directory(timestamptz, text, int)',
    'adventure_persona(text)',
    'adventure_persona_save_words(text, text, jsonb)',
    'adventure_persona_save_sheet(text, text, text, text, jsonb, text, text, text)',
    'adventure_log_save_shows(text, int, int)'
];
const REMADE = ['adventure_log(text, text)', 'adventure_log_directory(timestamptz, text, int)', 'adventure_persona(text)'];
const WITHHELD = ['adventure_greeting(jsonb)'];
const DROPPED = ['adventure_log_save(text, text, text)', 'adventure_log_set_hidden(text, int)', 'adventure_persona_save_words(text, text, int, int, text, jsonb)', 'adventure_persona_save_sheet(text, text, text, text, jsonb, text, text)'];
const REPLACED = ['adventure_dialogue', 'adventure_update_post', 'adventure_update_edit', 'adventure_reply_post', 'clan_notice_post', 'staff_adventure_reports', 'staff_adventure_resolve'];

// The tables whose bodies the posting functions cap at 200. Their own checks
// (013's and 017's) are left alone: see the 200 characters test.
const BODY_TABLES = ['adventure_update', 'adventure_reply', 'adventure_clan_notice'];

test('the website may call exactly these six, which take it from 108 to 107', () => {
    const grants = [...live.matchAll(/^GRANT EXECUTE ON FUNCTION accounts\.(.+?) TO website;$/gm)].map(m => m[1]);
    assert.deepEqual([...grants].sort(), [...GRANTED].sort());
    for (const signature of [...GRANTED, ...WITHHELD]) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`), `revoke ${signature}`);
    }
    // Counted from the files, not the lists above: 000..017 replayed give
    // what the website could run before, and this migration replayed on top
    // gives what it can run after.
    const was = [...earlier.values()].reduce((granted: ReadonlySet<string>, sql) => replay(sql, granted), new Set<string>());
    const now = replay(live, was);
    const added = grants.filter(signature => !was.has(signature));
    const dropped = [...was].filter(signature => !now.has(signature));
    assert.equal(grants.length, 6, 'six GRANT lines');
    assert.deepEqual(added.sort(), GRANTED.filter(signature => !REMADE.includes(signature)).sort(), 'three of them new: the three reads are granted again after being made anew');
    assert.deepEqual(dropped.sort(), [...DROPPED].sort(), 'the four old writers go');
    assert.equal(was.size, 108, '000..017 leave the website one hundred and eight functions');
    assert.equal(now.size, 107, 'and this one takes it to one hundred and seven');
    const header = live.slice(0, live.indexOf('\n\n')).replace(/\n--\s?/g, ' ');
    assert.ok(header.includes('The `website` role goes from one hundred and eight functions to one hundred and seven.'), 'the header says so');
});

test('every function it defines is new and listed, or one of the seven it replaces in place', () => {
    const listed = new Set([...GRANTED, ...WITHHELD].map(signature => signature.slice(0, signature.indexOf('('))));
    for (const name of defined.keys()) {
        assert.ok(listed.has(name) || REPLACED.includes(name), name);
    }
    for (const name of [...listed, ...REPLACED]) {
        assert.ok(defined.has(name), `${name} is defined`);
    }
    for (const [name, { header }] of defined) {
        assert.match(header, /SECURITY DEFINER SET search_path = public, pg_temp (SET jit = off )?AS $/m, `${name} is definer with a fixed path`);
    }
    assert.ok(fn('adventure_log_directory').header.includes('SET jit = off'), 'the directory keeps JIT off');
});

test('the old writers are dropped, and the three reads are dropped before they are made anew', () => {
    for (const signature of [...DROPPED, ...REMADE]) {
        assert.ok(live.includes(`DROP FUNCTION IF EXISTS accounts.${signature};`), `drop ${signature}`);
    }
    for (const signature of REMADE) {
        const name = signature.slice(0, signature.indexOf('('));
        assert.ok(live.indexOf(`DROP FUNCTION IF EXISTS accounts.${signature};`) < live.indexOf(`CREATE OR REPLACE FUNCTION accounts.${name}(`), `${name}: dropped first`);
    }
    for (const name of ['adventure_log_save', 'adventure_log_set_hidden']) {
        assert.ok(!defined.has(name), `${name} is not made again`);
    }
});

test('the columns: the headline and its look go, hidden_parts comes', () => {
    for (const statement of [
        'ALTER TABLE "adventure_log_profile" DROP CONSTRAINT IF EXISTS "adventure_log_profile_headline";',
        'ALTER TABLE "adventure_log_profile" DROP COLUMN IF EXISTS "headline";',
        'ALTER TABLE "adventure_log_profile" ADD COLUMN IF NOT EXISTS "hidden_parts" INTEGER NOT NULL DEFAULT 0;',
        'ALTER TABLE "adventure_log_profile" ADD CONSTRAINT "adventure_log_profile_parts" CHECK ("hidden_parts" BETWEEN 0 AND 31);',
        'ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_colour";',
        'ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_effect";',
        'ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "headline_colour";',
        'ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "headline_effect";'
    ]) {
        assert.ok(live.includes(statement), statement);
    }
    const partsCheck = live.indexOf('ADD CONSTRAINT "adventure_log_profile_parts"');
    assert.ok(live.lastIndexOf('DROP CONSTRAINT IF EXISTS "adventure_log_profile_parts";', partsCheck) !== -1, 'the parts check can be made twice');
    for (const [name, { body }] of defined) {
        assert.ok(!/\bheadline(_colour|_effect)?\b/.test(body), `${name} does not read a dropped column`);
    }
});

test('the move: a headline that fits becomes page 1, every page takes the look, and it runs once', () => {
    const start = live.indexOf('DO $$');
    const move = live.slice(start, live.indexOf('END $$;', start));
    assert.ok(start !== -1 && start < live.indexOf('DROP COLUMN IF EXISTS "headline"'), 'it runs before the columns go');
    assert.ok(move.includes("AND column_name = 'headline') THEN") && move.includes('RETURN; -- moved already'), 'skipped once the headline is gone');
    assert.ok(move.includes('LOCK TABLE public.adventure_log_profile, public.adventure_persona IN EXCLUSIVE MODE;'), 'no save lands halfway');
    assert.ok(move.includes("jsonb_build_object('colour', pe.headline_colour::int,") && move.includes("'effect', pe.headline_effect::int)"), 'every page takes the persona look');
    assert.ok(move.includes("AND pr.headline <> '' AND length(pr.headline) <= 60") && move.includes('AND jsonb_array_length(pe.dialogue::jsonb) < 5;'), 'sixty characters or fewer, on fewer than five pages');
    assert.ok(move.includes("'mood', 'neutral', 'emote', NULL, 'lines', jsonb_build_array(pr.headline)"), 'a neutral page with the headline as its one line');
    assert.ok(move.includes('|| pe.dialogue::jsonb)::text'), 'in front of the pages there were');
    assert.ok(move.includes('AND NOT EXISTS (SELECT 1 FROM public.adventure_persona pe WHERE pe.account_id = pr.account_id);'), 'a log with no persona gets one');
    assert.ok(move.includes("AND (length(pr.headline) > 60 OR jsonb_array_length(coalesce(pe.dialogue, '[]')::jsonb) >= 5);"), 'the rest are counted as dropped');
    assert.ok(move.includes("RAISE NOTICE '018: headlines moved into dialogue page 1: %; dropped (over 60 characters, or five pages already): %'"), 'the count is in the apply log');
    assert.ok(move.includes("RAISE NOTICE '018: kept as they are, over 200 characters: updates %, replies %, clan notices %'"), 'and so are the old long posts');
});

test('pages carry a colour 0..11 and an effect 0..2, and the greeting is page 1', () => {
    const dialogue = fn('adventure_dialogue').body;
    assert.ok(dialogue.includes("k NOT IN ('mood', 'emote', 'lines', 'colour', 'effect')"), 'the keys');
    assert.ok(dialogue.includes("IF v_page ? 'colour' THEN") && dialogue.includes('IF v_number NOT BETWEEN 0 AND 11 OR v_number <> trunc(v_number) THEN RETURN NULL; END IF;'), "the game's twelve colours, whole numbers");
    assert.ok(dialogue.includes("IF v_page ? 'effect' THEN") && dialogue.includes('IF v_number NOT BETWEEN 0 AND 2 OR v_number <> trunc(v_number) THEN RETURN NULL; END IF;'), 'none, wave and scroll');
    assert.ok(dialogue.includes("'colour', v_colour,") && dialogue.includes("'effect', v_effect));"), 'always stored, 0 when left out');
    // Everything else about a page is 016's.
    const old = before('016_adventure_persona', 'adventure_dialogue').body;
    for (const rule of ['jsonb_array_length(p_dialogue) > 5', "jsonb_array_length(v_page -> 'lines') NOT BETWEEN 1 AND 4", "accounts.adventure_text(v_line #>> '{}', 60, false)", 'accounts.adventure_moods()', 'accounts.adventure_emotes()']) {
        assert.ok(old.includes(rule) && dialogue.includes(rule), rule);
    }
    const greeting = fn('adventure_greeting');
    assert.ok(greeting.header.includes('RETURNS TABLE (greeting text, colour int, effect int)'), 'the greeting columns');
    assert.ok(greeting.body.includes("coalesce(p_dialogue -> 0 -> 'lines' ->> 0, '')"), "page 1's first line, or ''");
    assert.ok(greeting.body.includes("coalesce((p_dialogue -> 0 ->> 'colour')::int, 0)") && greeting.body.includes("coalesce((p_dialogue -> 0 ->> 'effect')::int, 0)"), "page 1's look, or 0 and 0");
});

test('the reads return the columns the website reads, in its order', () => {
    assert.ok(
        fn('adventure_log').header.includes(
            'RETURNS TABLE (result text, username text, joined_at timestamptz,\n               about text, custom_css text, css_disabled boolean, hidden_categories int,\n               is_owner boolean, viewer_blocked boolean, viewer_can_post boolean,\n               gender int, kits jsonb, colours jsonb, worn jsonb,\n               greeting text, greeting_colour int, greeting_effect int, hidden_parts int)'
        ),
        "adventure_log: 013's columns less the headline, then the greeting and the hidden parts"
    );
    assert.ok(
        fn('adventure_log_directory').header.includes('RETURNS TABLE (username text, greeting text, greeting_colour int, greeting_effect int,\n               last_at timestamptz, last_kind text, last_category int, last_body text)'),
        'the directory: the greeting in the headline place'
    );
    assert.ok(
        fn('adventure_persona').header.includes('RETURNS TABLE (title text, examine text, hangout text, goals jsonb, god text, home_town text, scene text,\n               facing int, signature_emote text, dialogue jsonb)'),
        'the persona: no headline colour or effect'
    );
    for (const name of ['adventure_log', 'adventure_log_directory', 'staff_adventure_reports']) {
        assert.ok(/LEFT JOIN LATERAL accounts\.adventure_greeting\(\w+\.dialogue::jsonb\) \w+ ON true/.test(fn(name).body), `${name} reads the greeting through adventure_greeting`);
    }
    assert.ok(fn('adventure_log').body.includes('g.greeting, g.colour, g.effect, coalesce(p.hidden_parts, 0)'), 'adventure_log: the new columns');
    // the directory orders and pages as 014's did
    const directory = fn('adventure_log_directory').body;
    const was = before('014_adventure_directory', 'adventure_log_directory').body;
    for (const rule of ['ORDER BY greatest(l.event_at, l.update_at) DESC, l.username', 'LIMIT least(greatest(coalesce(p_limit, 30), 1), 50) + 1', 'ORDER BY pg.at DESC, pg.username;', "e.occurred_at <= now() - interval '20 minutes'"]) {
        assert.ok(was.includes(rule) && directory.includes(rule), rule);
    }
    // ...and a log with its adventures hidden has nothing public (ruling R-A2)
    const latest = directory.slice(0, directory.indexOf('), page AS ('));
    assert.ok(latest.includes('AND (coalesce(p.hidden_parts, 0) & 16) = 0'), 'no adventures shown, no directory row');
    assert.ok(!was.includes('hidden_parts'), "a rule 014's directory did not have");
});

test('a mute stops words, not picks', () => {
    const words = fn('adventure_persona_save_words').body;
    assert.ok(words.includes('accounts.adventure_author(p_username, false)'), 'words: the author check ignores the mute');
    assert.ok(words.includes('accounts.adventure_dialogue_lines(v_old) IS DISTINCT FROM accounts.adventure_dialogue_lines(v_dialogue)'), 'words: only the lines, in order');
    const sheet = fn('adventure_persona_save_sheet').body;
    assert.ok(sheet.includes('accounts.adventure_author(p_username, false)'), 'sheet: the author check ignores the mute');
    assert.ok(sheet.includes('(v_old.title, v_old.examine, v_old.hangout, v_old.goals, v_old.about)'), "sheet: its words, About's too");
    for (const body of [words, sheet]) {
        assert.ok(body.includes("RETURN 'muted'"), 'refuses changed words');
        const lock = body.indexOf("PERFORM pg_advisory_xact_lock(hashtext('adventure_persona:' || v_author.account_id));");
        assert.ok(lock !== -1 && lock < body.indexOf('muted_until') && lock < body.indexOf('INSERT INTO'), 'the persona lock, before the old words are read');
    }
    const shows = fn('adventure_log_save_shows').body;
    assert.ok(shows.includes('accounts.adventure_author(p_username, false)') && !shows.includes('muted_until') && !shows.includes("RETURN 'muted'"), 'shows: picks only');
    for (const name of ['adventure_update_post', 'adventure_update_edit', 'adventure_reply_post', 'clan_notice_post']) {
        assert.ok(fn(name).body.includes('accounts.adventure_author(p_username, true)'), `${name}: a mute refuses it`);
    }
});

test('About is saved with the sheet: up to 1000, on the profile, in the same call', () => {
    const sheet = fn('adventure_persona_save_sheet');
    assert.ok(sheet.header.includes('p_home text,\n') && sheet.header.includes('p_about text)'), 'About comes last');
    assert.ok(sheet.body.includes('v_about text := accounts.adventure_text(p_about, 1000, true);'), 'up to 1000, empty allowed, newlines allowed');
    assert.ok(sheet.body.includes("IF v_about IS NULL THEN RETURN 'bad_about'; END IF;"), 'bad_about');
    assert.ok(sheet.body.indexOf("RETURN 'bad_key'") < sheet.body.indexOf("RETURN 'bad_about'"), 'after the home town');
    assert.ok(
        sheet.body.includes('INSERT INTO public.adventure_log_profile (account_id, about, updated_at)') && sheet.body.includes('ON CONFLICT (account_id) DO UPDATE SET about = excluded.about, updated_at = excluded.updated_at;'),
        'upserted on the profile'
    );
    // 017's checks, in 017's order, before it
    const old = before('017_adventure_clans', 'adventure_persona_save_sheet').body;
    const codes = (body: string) => [...body.matchAll(/RETURN '(bad_\w+)'/g)].map(m => m[1]);
    assert.deepEqual(codes(sheet.body), [...codes(old), 'bad_about']);
    const words = fn('adventure_persona_save_words');
    assert.ok(words.header.includes('(p_username text, p_emote text, p_dialogue jsonb)'), 'words take the emote and the pages');
    assert.deepEqual(codes(words.body), ['bad_emote', 'bad_dialogue']);
    assert.ok(words.body.includes('INSERT INTO public.adventure_persona (account_id, signature_emote, dialogue, updated_at)') && !words.body.includes('adventure_log_profile'), 'the profile is not the words tab');
});

test('what a log shows: 0..255 kinds of adventure and 0..31 parts, together', () => {
    const shows = fn('adventure_log_save_shows').body;
    assert.ok(shows.includes('IF p_categories IS NULL OR p_categories NOT BETWEEN 0 AND 255') && shows.includes("OR p_parts IS NULL OR p_parts NOT BETWEEN 0 AND 31 THEN RETURN 'bad_mask'; END IF;"), 'the two masks');
    assert.ok(shows.includes('SET hidden_categories = excluded.hidden_categories, hidden_parts = excluded.hidden_parts,'), 'saved together');
    const header = live.slice(0, live.indexOf('\n\n')).replace(/\n--\s?/g, ' ');
    assert.ok(header.includes('dialogue 1, wardrobe 2, records 4, about 8, adventures 16 (0..31)'), "the bits, as the website's lib/adventurer-log/parts.ts has them");
    assert.ok(header.includes('A log with adventures hidden has no public activity'), 'and what hiding adventures does to the directory');
});

test('200 characters: the four writers cap it, and the tables keep their own checks', () => {
    // Ruling R-A1: Postgres checks every row an UPDATE writes, so a tighter
    // table check would stop an old long post being deleted, hidden or
    // pinned. The functions are the only write path.
    for (const table of BODY_TABLES) {
        assert.ok(!migration.includes(`"${table}_body"`), `${table}: its body check is not touched, nor mentioned in the rollback`);
        assert.ok(!new RegExp(`ALTER TABLE "${table}"`).test(live), `${table}: not altered at all`);
    }
    assert.ok(!live.includes('NOT VALID'), 'no NOT VALID check');
    // Each posting function is the one before it with only the limit changed.
    for (const [file, name, limit] of [
        ['013_adventurer_log', 'adventure_update_post', 2000],
        ['013_adventurer_log', 'adventure_reply_post', 500],
        ['017_adventure_clans', 'clan_notice_post', 280]
    ] as const) {
        const old = before(file, name).body;
        assert.ok(old.includes(`accounts.adventure_text(p_body, ${limit}, false)`), `${name} was ${limit}`);
        assert.equal(fn(name).body, old.replace(`accounts.adventure_text(p_body, ${limit}, false)`, 'accounts.adventure_text(p_body, 200, false)'), `${name}: 200, and nothing else changed`);
    }
    const edit = fn('adventure_update_edit').body;
    assert.ok(edit.includes('v_body text := accounts.adventure_text(p_body, 200, false);'), 'an edit is 200 too');
    const same = edit.indexOf("IF accounts.adventure_text(p_body, 2000, false) = v_old THEN RETURN 'ok'; END IF;");
    assert.ok(same !== -1 && same > edit.indexOf("RETURN 'not_found'") && same < edit.indexOf("IF v_body IS NULL THEN RETURN 'bad_body'; END IF;"), 'the same text, even over 200, is ok before the length is checked');
});

test('a staff hide on a log no longer touches the headline, and staff see the greeting', () => {
    const resolve = fn('staff_adventure_resolve').body;
    const old = before('017_adventure_clans', 'staff_adventure_resolve').body;
    const was = "UPDATE public.adventure_log_profile SET headline = '', about = '', updated_at = now() WHERE account_id = v_report.target_id;";
    const now = "UPDATE public.adventure_log_profile SET about = '', updated_at = now() WHERE account_id = v_report.target_id;";
    assert.ok(old.includes(was), "017's hide");
    assert.equal(resolve, old.replace(was, now), "017's resolve, with only the headline gone");
    const reports = fn('staff_adventure_reports').body;
    assert.ok(reports.includes("CASE WHEN lo.id IS NOT NULL THEN lg.greeting || E'\\n\\n' || coalesce(lp.about, '') END"), "a log's content: its greeting and About");
    assert.ok(reports.includes('LEFT JOIN public.adventure_persona lpe ON lpe.account_id = lo.id'), "the log's persona");
});

test('the rollback is all comments, goes back only before W4, and says where the old functions are', () => {
    for (const line of rollback.split('\n')) {
        assert.ok(line === '' || line.startsWith('--'), `rollback line is a comment: ${line}`);
    }
    assert.ok(rollback.includes('Forward only once Website W4 (feat/pages-speak) is live'), 'forward only once W4 is live');
    for (const signature of [...GRANTED, ...WITHHELD]) {
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${signature};`), `drop ${signature}`);
    }
    for (const statement of [
        '-- ALTER TABLE "adventure_log_profile" ADD COLUMN IF NOT EXISTS "headline" TEXT NOT NULL DEFAULT \'\';',
        '-- ALTER TABLE "adventure_log_profile" DROP COLUMN IF EXISTS "hidden_parts";',
        '-- ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "headline_colour" SMALLINT NOT NULL DEFAULT 0;',
        '-- ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "headline_effect" SMALLINT NOT NULL DEFAULT 0;'
    ]) {
        assert.ok(rollback.includes(statement), statement);
    }
    assert.ok(rollback.includes("page - 'colour' - 'effect'"), 'the pages lose their look before 016 reads them again');
    for (const file of ['013_adventurer_log', '014_adventure_directory', '015_adventure_timeline_v2', '016_adventure_persona', '017_adventure_clans']) {
        assert.ok(rollback.includes(file), `says what comes back from ${file}`);
    }
});

test('every backend and schema: no headline, no headline look, and hidden_parts', () => {
    assert.equal(
        mysqlMigration,
        '-- AlterTable\nALTER TABLE `adventure_log_profile` DROP COLUMN `headline`,\n    ADD COLUMN `hidden_parts` INTEGER NOT NULL DEFAULT 0;\n\n-- AlterTable\nALTER TABLE `adventure_persona` DROP COLUMN `headline_colour`,\n    DROP COLUMN `headline_effect`;\n',
        "mysql: Prisma's own diff"
    );
    const table = (sql: string, open: string) => {
        const start = sql.indexOf(open);
        assert.notEqual(start, -1, open);
        return sql.slice(start, sql.indexOf('\n)', start));
    };
    const profile = table(sqliteBaseline, 'CREATE TABLE "adventure_log_profile" (');
    assert.ok(profile.includes('\n    "hidden_parts" INTEGER NOT NULL DEFAULT 0,') && !profile.includes('"headline"'), 'sqlite profile');
    assert.ok(!/"headline_(colour|effect)"/.test(table(sqliteBaseline, 'CREATE TABLE "adventure_persona" (')), 'sqlite persona');
    for (const [name, schema] of Object.entries(schemas)) {
        const log = modelBody(schema, 'adventure_log_profile');
        assert.ok(/^\s+hidden_parts\s+Int\s+@default\(0\)$/m.test(log), `${name}: hidden_parts`);
        assert.ok(!/^\s+headline\s/m.test(log), `${name}: no headline`);
        assert.ok(!/^\s+headline_(colour|effect)\s/m.test(modelBody(schema, 'adventure_persona')), `${name}: no headline look`);
    }
    const profileType = types.slice(types.indexOf('export type adventure_log_profile = {'));
    assert.ok(profileType.slice(0, profileType.indexOf('};')).includes('hidden_parts: Generated<number>;') && !profileType.slice(0, profileType.indexOf('};')).includes('headline'), 'types: the profile');
    const personaType = types.slice(types.indexOf('export type adventure_persona = {'));
    assert.ok(!personaType.slice(0, personaType.indexOf('};')).includes('headline'), 'types: the persona');
});
