import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 17, read back from the file, and its four tables in all six
// places. Its behaviour is rehearsed against a real postgres outside this
// repo (tests/migration-017.sql); what must not drift silently is pinned
// here: which functions the website may call and which are gone, the rank
// ladder and report kinds the site shares with the database, the mute rule
// on every write (picks yes, words no), the locks, the limits, the bans in
// the public reads, and what a staff "hide" on a clan does.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function modelBody(schema: string, model: string): string {
    const start = schema.indexOf(`\nmodel ${model} {`);
    assert.notEqual(start, -1, `model ${model}`);
    const body = schema.slice(start);
    return body.slice(0, body.indexOf('\n}'));
}

const migration = read('../prisma/postgres/migrations/017_adventure_clans/migration.sql');
// Every migration before this one, in order, for what the website could
// already call.
const earlier = readdirSync(new URL('../prisma/postgres/migrations', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{3}_/.test(entry.name) && entry.name < '017_')
    .map(entry => entry.name)
    .sort()
    .map(name => read(`../prisma/postgres/migrations/${name}/migration.sql`));
const mysqlMigration = read('../prisma/multiworld/migrations/20260927000000_adventure_clans/migration.sql');
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

const RANKS = ['leader', 'general', 'captain', 'lieutenant', 'sergeant', 'corporal', 'recruit'];
const quoted = (list: string[]) => list.map(item => `'${item}'`).join(', ');

const GRANTED = [
    'adventure_persona(text)',
    'adventure_persona_save_words(text, text, int, int, text, jsonb)',
    'adventure_persona_save_sheet(text, text, text, text, jsonb, text, text)',
    'adventure_persona_save_stage(text, text, int)',
    'clan_page(text)',
    'clan_members(int)',
    'clan_notices(int)',
    'clan_directory()',
    'clan_of(text)',
    'clan_invites_for(text)',
    'clan_invites_sent(text)',
    'clan_create(text, text, text, int, int)',
    'clan_save_page(text, text, text, int, int, text)',
    'clan_set_perms(text, int, int, int, int)',
    'clan_invite(text, text)',
    'clan_invite_cancel(text, text)',
    'clan_invite_answer(text, int, boolean)',
    'clan_set_rank(text, text, text)',
    'clan_remove(text, text)',
    'clan_leave(text)',
    'clan_hand_over(text, text)',
    'clan_disband(text)',
    'clan_notice_post(text, text, text)',
    'clan_notice_delete(text, int)'
];
const WITHHELD = ['clan_rank_level(text)', 'clan_slug(text)', 'clan_name_ok(text)', 'clan_membership(int)', 'adventure_dialogue_lines(jsonb)'];
const DROPPED = ['adventure_persona_save(text, text, int, int, text, text, text, text, jsonb, text, text, text, text, text, jsonb)', 'adventure_persona_words(text, text, text, text, text, jsonb, jsonb)'];
const REPLACED = ['adventure_report', 'staff_adventure_reports', 'staff_adventure_resolve'];

// Every write, by how it treats a mute: SPEAKING asks adventure_author with
// p_speaking (a mute refuses it outright); COMPARED reads the mute itself and
// refuses only changed words; PICKS never looks at a mute.
const SPEAKING = ['clan_create', 'clan_notice_post'];
const COMPARED = ['adventure_persona_save_words', 'adventure_persona_save_sheet', 'clan_save_page'];
const PICKS = ['adventure_persona_save_stage', 'clan_set_perms', 'clan_invite', 'clan_invite_cancel', 'clan_invite_answer', 'clan_set_rank', 'clan_remove', 'clan_leave', 'clan_hand_over', 'clan_disband', 'clan_notice_delete'];
// The writes that act on the caller's own clan, each through the helper
// that takes that clan's lock.
const MEMBER_WRITES = ['clan_save_page', 'clan_set_perms', 'clan_invite', 'clan_invite_cancel', 'clan_set_rank', 'clan_remove', 'clan_leave', 'clan_hand_over', 'clan_disband', 'clan_notice_post', 'clan_notice_delete'];
// The reads; the public ones leave banned accounts out.
const READS = ['adventure_persona', 'clan_page', 'clan_members', 'clan_notices', 'clan_directory', 'clan_of', 'clan_invites_for', 'clan_invites_sent'];
const PUBLIC_READS = ['clan_page', 'clan_members', 'clan_notices', 'clan_directory', 'clan_of'];

const COLUMNS: Record<string, string[]> = {
    adventure_clan: ['id', 'name', 'slug', 'motto', 'crest', 'world', 'about', 'perm_invite', 'perm_remove', 'perm_ranks', 'perm_page', 'created_at', 'updated_at'],
    adventure_clan_member: ['account_id', 'clan_id', 'rank', 'joined_at'],
    adventure_clan_invite: ['clan_id', 'account_id', 'invited_by_account_id', 'created_at'],
    adventure_clan_notice: ['id', 'clan_id', 'author_account_id', 'title', 'body', 'created_at', 'deleted_at']
};
const INDEXES = ['adventure_clan_member_clan_id_idx', 'adventure_clan_invite_account_id_idx', 'adventure_clan_notice_clan_id_created_at_idx'];
const SLUG_KEY = 'adventure_clan_slug_key';

test('the website may call exactly these twenty-four, which take it from 86 to 108', () => {
    const grants = [...live.matchAll(/^GRANT EXECUTE ON FUNCTION accounts\.(.+?) TO website;$/gm)].map(m => m[1]);
    assert.deepEqual([...grants].sort(), [...GRANTED].sort());
    for (const signature of [...GRANTED, ...WITHHELD]) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`), `revoke ${signature}`);
    }
    // Counted from the files, not the lists above: 000..016 replayed give
    // what the website could run before, and this migration replayed on top
    // gives what it can run after.
    const before = earlier.reduce((granted: ReadonlySet<string>, sql) => replay(sql, granted), new Set<string>());
    const after = replay(live, before);
    const added = grants.filter(signature => !before.has(signature));
    const dropped = [...before].filter(signature => !after.has(signature));
    assert.equal(grants.length, 24, 'twenty-four GRANT lines');
    assert.equal(added.length, 23, 'twenty-three of them new: adventure_persona is granted again after being made anew');
    assert.deepEqual(dropped, [DROPPED[0]], 'adventure_persona_save is the one granted function to go');
    assert.equal(before.size, 86, '000..016 leave the website eighty-six functions');
    assert.equal(after.size, 108, 'and this one takes it to one hundred and eight');
    const header = live.slice(0, live.indexOf('\n\n')).replace(/\n--\s?/g, ' ');
    assert.ok(header.includes('The `website` role goes from eighty-six functions to one hundred and eight.'), 'the header says so');
});

test('every function it defines is new and listed, or one of the three it replaces', () => {
    const listed = new Set([...GRANTED, ...WITHHELD].map(signature => signature.slice(0, signature.indexOf('('))));
    for (const name of defined.keys()) {
        assert.ok(listed.has(name) || REPLACED.includes(name), name);
    }
    for (const name of listed) {
        assert.ok(defined.has(name), `${name} is defined`);
    }
    for (const [name, { header }] of defined) {
        assert.match(header, /SECURITY DEFINER SET search_path = public, pg_temp AS $/m, `${name} is definer with a fixed path`);
    }
});

test('the old persona save and its words helper are dropped, and adventure_persona is made anew', () => {
    for (const signature of DROPPED) {
        assert.ok(live.includes(`DROP FUNCTION IF EXISTS accounts.${signature};`), `drop ${signature}`);
        assert.ok(!defined.has(signature.slice(0, signature.indexOf('('))), `${signature} is not made again`);
    }
    const drop = live.indexOf('DROP FUNCTION IF EXISTS accounts.adventure_persona(text);');
    assert.notEqual(drop, -1, 'its result columns change, so it is dropped');
    assert.ok(drop < live.indexOf('CREATE OR REPLACE FUNCTION accounts.adventure_persona('), 'before it is made');
    const persona = fn('adventure_persona').header;
    assert.ok(persona.includes('hangout text,'), 'the columns start as before');
    assert.ok(persona.includes('home_town text, scene text, facing int, signature_emote text,'), 'facing sits after the scene');
    assert.ok(!/\bclan\b|\bplaystyle\b/.test(persona), 'no clan, no playstyle');
});

test('the persona loses clan and playstyle, and gains a facing of 0..15', () => {
    for (const statement of [
        'ALTER TABLE "adventure_persona" DROP CONSTRAINT IF EXISTS "adventure_persona_clan";',
        'ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "clan";',
        'ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "playstyle";',
        'ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "facing" SMALLINT NOT NULL DEFAULT 0;',
        'ALTER TABLE "adventure_persona" ADD CONSTRAINT "adventure_persona_facing" CHECK ("facing" BETWEEN 0 AND 15);'
    ]) {
        assert.ok(live.includes(statement), statement);
    }
    const keysAt = live.indexOf('ADD CONSTRAINT "adventure_persona_keys"');
    assert.ok(live.lastIndexOf('DROP CONSTRAINT IF EXISTS "adventure_persona_keys";', keysAt) !== -1, 'the old keys check goes first');
    const keys = live.slice(keysAt, live.indexOf(';', keysAt));
    assert.ok(keys.includes('"home_town"') && keys.includes('"scene"') && !keys.includes('playstyle'), keys);
    for (const [name, { body }] of defined) {
        assert.ok(!/\bplaystyle\b/.test(body), `${name} does not mention playstyle`);
    }
    assert.ok(fn('adventure_persona_save_stage').body.includes('p_facing NOT BETWEEN 0 AND 15'), 'the stage checks the facing');
});

test('the rank ladder and the report kinds match the site', () => {
    assert.ok(live.includes(`CHECK ("rank" IN (${quoted(RANKS)}))`), 'the table check');
    assert.ok(fn('clan_rank_level').body.includes(`ARRAY[${quoted(RANKS)}]`), 'the levels');
    assert.ok(live.includes("CHECK (\"target_kind\" IN ('update', 'reply', 'log', 'clan'))"), 'report kinds');
    assert.ok(live.includes('ALTER TABLE "adventure_report" DROP CONSTRAINT IF EXISTS "adventure_report_kind";'), 'the old kinds go first');
    for (const [column, level] of [
        ['perm_invite', 4],
        ['perm_remove', 1],
        ['perm_ranks', 1],
        ['perm_page', 2]
    ]) {
        assert.ok(live.includes(`"${column}" SMALLINT NOT NULL DEFAULT ${level},`), `${column} defaults to ${level}`);
        assert.ok(live.includes(`"${column}" BETWEEN 0 AND 6`), `${column} is a level`);
    }
    assert.ok(live.includes('CREATE UNIQUE INDEX IF NOT EXISTS "adventure_clan_member_one_leader_key" ON "adventure_clan_member"("clan_id") WHERE "rank" = \'leader\';'), 'one Leader per clan');
});

test("names, slugs and lengths are the site's", () => {
    assert.ok(live.includes('CHECK ("name" ~ \'^[A-Za-z0-9]( ?[A-Za-z0-9])*$\' AND length("name") BETWEEN 1 AND 20)'), 'the name rule');
    assert.ok(live.includes('CHECK ("slug" = replace(lower("name"), \' \', \'-\'))'), 'the slug follows the name');
    assert.ok(fn('clan_name_ok').body.includes("lower(p_name) !~ '^clan [0-9]+$'"), 'Clan <number> is kept for staff');
    assert.ok(fn('clan_slug').body.includes("replace(lower(p_name), ' ', '-')"), 'the slug');
    for (const check of [
        'CHECK (length("motto") <= 80 AND position(E\'\\n\' IN "motto") = 0)',
        'CHECK ("crest" BETWEEN 0 AND 65535)',
        'CHECK ("world" BETWEEN 1 AND 255)',
        'CHECK (length("about") <= 600)',
        'CHECK (length("title") BETWEEN 1 AND 40 AND position(E\'\\n\' IN "title") = 0)',
        'CHECK (length("body") BETWEEN 1 AND 280)'
    ]) {
        assert.ok(live.includes(check), check);
    }
});

test('a mute stops words, not picks', () => {
    const writes = GRANTED.map(signature => signature.slice(0, signature.indexOf('('))).filter(name => !READS.includes(name));
    assert.deepEqual([...SPEAKING, ...COMPARED, ...PICKS].sort(), writes.sort(), 'every write is in exactly one list');
    for (const name of SPEAKING) {
        assert.ok(fn(name).body.includes('accounts.adventure_author(p_username, true)'), `${name}: a mute refuses it`);
    }
    for (const name of COMPARED) {
        const body = fn(name).body;
        assert.ok(body.includes('accounts.adventure_author(p_username, false)'), `${name}: the author check ignores the mute`);
        assert.ok(body.includes('muted_until'), `${name}: the mute is read separately`);
        assert.ok(body.includes("RETURN 'muted'"), `${name}: and refuses changed words`);
    }
    for (const name of PICKS) {
        const body = fn(name).body;
        assert.ok(body.includes('accounts.adventure_author(p_username, false)'), `${name}: the author check ignores the mute`);
        assert.ok(!body.includes('muted_until') && !body.includes("RETURN 'muted'"), `${name}: picks only`);
    }
    assert.ok(fn('adventure_persona_save_words').body.includes('accounts.adventure_dialogue_lines(v_old.dialogue) IS DISTINCT FROM accounts.adventure_dialogue_lines(v_dialogue)'), 'the lines, in order');
    assert.ok(fn('adventure_persona_save_sheet').body.includes('(v_old.title, v_old.examine, v_old.hangout, v_old.goals)'), "the sheet's words");
    assert.ok(fn('clan_save_page').body.includes('(v_clan.name, v_clan.motto, v_clan.about) IS DISTINCT FROM (p_name, v_motto, v_about)'), "the page's words");
    // A muted save compares the stored words and then writes; a staff hide
    // on the log blanks them. Both take the persona's lock first, so a save
    // cannot read the words before a hide and write them back after it.
    for (const name of ['adventure_persona_save_words', 'adventure_persona_save_sheet']) {
        const body = fn(name).body;
        const lock = body.indexOf("PERFORM pg_advisory_xact_lock(hashtext('adventure_persona:' || v_author.account_id));");
        assert.ok(lock !== -1 && lock < body.indexOf('muted_until') && lock < body.indexOf('INSERT INTO'), `${name}: the persona lock, before the old words are read`);
    }
    const resolve = fn('staff_adventure_resolve').body;
    const logLock = resolve.indexOf("PERFORM pg_advisory_xact_lock(hashtext('adventure_persona:' || v_report.target_id));");
    assert.ok(
        logLock > resolve.indexOf("ELSIF v_report.target_kind = 'clan' THEN") && logLock < resolve.indexOf("UPDATE public.adventure_log_profile SET headline = ''") && logLock < resolve.indexOf("UPDATE public.adventure_persona SET title = ''"),
        "a log hide takes the persona's lock before it blanks the words"
    );
});

test("clan writes and a staff hide hold the clan's lock; creating and joining hold the account's too", () => {
    assert.ok(fn('clan_membership').body.includes("PERFORM pg_advisory_xact_lock(hashtext('clan:' || v_clan));"), 'the helper takes the clan lock');
    for (const name of MEMBER_WRITES) {
        assert.ok(fn(name).body.includes('v_me := accounts.clan_membership(v_author.account_id);'), `${name} starts at clan_membership`);
    }
    const leave = fn('clan_leave').body;
    assert.ok(leave.includes('RETURN accounts.clan_disband(p_username);'), 'the last Leader leaving disbands through clan_disband');
    assert.ok(!leave.includes('DELETE FROM public.adventure_clan c'), 'rather than repeating its deletes');
    const resolve = fn('staff_adventure_resolve').body;
    const hide = resolve.slice(resolve.indexOf("ELSIF v_report.target_kind = 'clan' THEN"));
    const hideLock = hide.indexOf("PERFORM pg_advisory_xact_lock(hashtext('clan:' || v_report.target_id));");
    assert.ok(hideLock !== -1 && hideLock < hide.indexOf('UPDATE public.adventure_clan ') && hideLock < hide.indexOf('UPDATE public.adventure_clan_notice'), 'a staff hide takes the clan lock before it writes');
    const answer = fn('clan_invite_answer').body;
    const clanLock = answer.indexOf("pg_advisory_xact_lock(hashtext('clan:' || p_clan_id))");
    const accountLock = answer.indexOf("pg_advisory_xact_lock(hashtext('clan-account:' || v_author.account_id))");
    assert.ok(clanLock !== -1 && accountLock !== -1 && clanLock < accountLock, 'accepting: the clan, then the account');
    assert.ok(fn('clan_create').body.includes("pg_advisory_xact_lock(hashtext('clan-account:' || v_author.account_id))"), 'creating: the account');
});

test('the limits', () => {
    const invite = fn('clan_invite').body;
    assert.ok(invite.includes(">= 50 THEN RETURN 'full';"), '50 members');
    assert.ok(invite.includes(">= 20 THEN RETURN 'too_many';"), '20 pending invites');
    assert.ok(/>= 50 THEN\s+RETURN 'full';/.test(fn('clan_invite_answer').body), '50 members, when accepting');
    // Ten notices a clan a day, counting deleted ones: deleting a notice (or
    // a staff hide) marks it, and does not free its place in the day.
    const post = fn('clan_notice_post').body;
    assert.ok(post.includes("n.created_at > now() - interval '1 day') >= 10 THEN"), 'ten notices a day');
    const today = post.slice(post.indexOf('IF (SELECT count(*) FROM public.adventure_clan_notice n'), post.indexOf("RETURN 'rate_limited';"));
    assert.ok(today.includes('>= 10 THEN') && !today.includes('deleted_at'), 'the ten a day count deleted notices too');
    assert.ok(post.includes('WHERE k.clan_id = v_me.clan_id AND k.deleted_at IS NULL') && post.includes('ORDER BY k.created_at DESC, k.id DESC') && post.includes('LIMIT 20)'), 'the newest twenty live notices kept');
    assert.ok(post.includes("n.deleted_at IS NOT NULL AND n.created_at <= now() - interval '1 day'"), 'a deleted notice goes once it no longer counts for the day');
    const notices = fn('clan_notices').body;
    assert.ok(notices.includes('n.deleted_at IS NULL') && notices.includes('LIMIT 20;'), 'twenty shown, none deleted');
    const remove = fn('clan_notice_delete').body;
    assert.ok(remove.includes('WHERE n.id = p_id AND n.clan_id = v_me.clan_id AND n.deleted_at IS NULL;'), 'a deleted notice is no_notice');
    assert.ok(remove.includes('UPDATE public.adventure_clan_notice n SET deleted_at = now() WHERE n.id = p_id;') && !remove.includes('DELETE FROM'), 'deleting marks the notice');
    assert.ok(fn('clan_disband').body.includes('DELETE FROM public.adventure_clan_notice n WHERE n.clan_id = v_me.clan_id;'), 'disbanding deletes every notice for good');
    const directory = fn('clan_directory').body;
    assert.ok(directory.includes('WHERE v.members > 0') && directory.includes('ORDER BY v.members DESC, c.name, c.id') && directory.includes('LIMIT 200;'), 'the directory');
});

test('banned players are left out of every public read', () => {
    for (const name of PUBLIC_READS) {
        assert.ok(fn(name).body.includes('a.banned_until IS NULL OR a.banned_until <= now()'), `${name} leaves banned accounts out`);
    }
    assert.ok(fn('clan_page').body.includes("m.rank = 'leader'"), 'the Leader, when not banned');
    assert.ok(fn('clan_invite').body.includes('a.username = p_target AND (a.banned_until IS NULL OR a.banned_until <= now())'), 'no inviting a banned name');
    assert.ok(fn('clan_hand_over').body.includes('a.username = p_target AND (a.banned_until IS NULL OR a.banned_until <= now())'), 'no key for a banned member');
});

test('reports cover clans, and a staff hide renames one', () => {
    const report = fn('adventure_report').body;
    assert.ok(report.includes("ELSIF p_kind = 'clan' THEN"), 'the new kind');
    assert.ok(report.includes('LEFT JOIN public.adventure_clan_member m ON m.clan_id = c.id AND m.account_id = v_author.account_id'), "a member is its own clan's owner: self");
    const reports = fn('staff_adventure_reports').body;
    assert.ok(reports.includes("CASE WHEN c.id IS NOT NULL THEN c.motto || E'\\n' || c.about END"), 'the content');
    assert.ok(reports.includes("WHEN r.target_kind = 'clan' THEN CASE WHEN c.id IS NULL THEN 'deleted' ELSE 'shown' END"), 'the state');
    assert.ok(reports.includes("LEFT JOIN public.adventure_clan_member cm ON cm.clan_id = c.id AND cm.rank = 'leader'"), 'the author is the Leader');
    const resolve = fn('staff_adventure_resolve').body;
    assert.ok(resolve.includes("UPDATE public.adventure_clan SET name = 'Clan ' || v_report.target_id, slug = 'clan-' || v_report.target_id, motto = '', about = ''"), 'renamed and blanked');
    assert.ok(resolve.includes('UPDATE public.adventure_clan_notice SET deleted_at = now() WHERE clan_id = v_report.target_id AND deleted_at IS NULL;'), 'its notices deleted, and still counted for the day');
    assert.ok(!resolve.includes('DELETE FROM public.adventure_clan_notice'), 'marked, not removed');
    assert.ok(resolve.includes("UPDATE public.adventure_persona SET title = '', examine = '', hangout = '', goals = '[]', dialogue = '[]', updated_at = now() WHERE account_id = v_report.target_id;"), 'a log hide without the clan column');
    assert.ok(!resolve.includes("clan = ''"), 'no clan column left to blank');
});

test('the four tables: RLS on, no policy, no foreign key, and their indexes', () => {
    for (const table of Object.keys(COLUMNS)) {
        assert.ok(live.includes(`CREATE TABLE IF NOT EXISTS "${table}" (`), `CREATE TABLE ${table}`);
        assert.ok(live.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`), `RLS ${table}`);
    }
    assert.ok(!live.includes('CREATE POLICY'), 'no policies');
    assert.ok(!/\bREFERENCES\b/.test(live), 'no foreign keys, like every other table');
    assert.ok(live.includes(`CREATE UNIQUE INDEX IF NOT EXISTS "${SLUG_KEY}" ON "adventure_clan"("slug");`), 'slugs are unique');
    for (const index of INDEXES) {
        assert.ok(live.includes(`CREATE INDEX IF NOT EXISTS "${index}"`), index);
    }
});

test('the rollback is all comments and undoes everything', () => {
    for (const line of rollback.split('\n')) {
        assert.ok(line === '' || line.startsWith('--'), `rollback line is a comment: ${line}`);
    }
    for (const signature of [...GRANTED, ...WITHHELD]) {
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${signature};`), `drop ${signature}`);
    }
    for (const table of Object.keys(COLUMNS)) {
        assert.ok(rollback.includes(`-- DROP TABLE IF EXISTS "${table}";`), `drop ${table}`);
    }
    // deleted_at is a column of 017's own CREATE TABLE, never added by an
    // ALTER, so dropping adventure_clan_notice drops it too.
    assert.ok(!/ADD COLUMN[^;]*"deleted_at"/.test(live), 'deleted_at comes and goes with its table');
    assert.ok(rollback.includes('-- ALTER TABLE "adventure_persona" DROP COLUMN IF EXISTS "facing";'), 'facing goes');
    assert.ok(rollback.includes('-- ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "clan" TEXT NOT NULL DEFAULT \'\';'), 'clan comes back');
    assert.ok(rollback.includes('-- ALTER TABLE "adventure_persona" ADD COLUMN IF NOT EXISTS "playstyle" TEXT;'), 'playstyle comes back');
    assert.ok(rollback.includes('-- DELETE FROM "adventure_report" WHERE "target_kind" = \'clan\';'), 'clan reports go before the kind does');
    assert.ok(rollback.includes('016_adventure_persona') && rollback.includes('013_adventurer_log'), 'says where the replaced functions come back from');
});

test('every backend has the four tables, and the persona without clan and playstyle', () => {
    // A table's statement, from its CREATE TABLE to its closing parenthesis.
    const table = (sql: string, open: string) => {
        const start = sql.indexOf(open);
        assert.notEqual(start, -1, open);
        return sql.slice(start, sql.indexOf('\n)', start));
    };
    for (const [name, columns] of Object.entries(COLUMNS)) {
        const postgres = table(live, `CREATE TABLE IF NOT EXISTS "${name}" (`);
        const mysql = table(mysqlMigration, `CREATE TABLE \`${name}\` (`);
        const sqlite = table(sqliteBaseline, `CREATE TABLE "${name}" (`);
        for (const column of columns) {
            assert.ok(postgres.includes(`\n    "${column}" `), `postgres ${name}.${column}`);
            assert.ok(mysql.includes(`\n    \`${column}\` `), `mysql ${name}.${column}`);
            assert.ok(sqlite.includes(`\n    "${column}" `), `sqlite ${name}.${column}`);
        }
    }
    assert.ok(table(live, 'CREATE TABLE IF NOT EXISTS "adventure_clan_notice" (').includes('\n    "deleted_at" TIMESTAMPTZ(3),'), 'postgres: a notice can be deleted');
    for (const index of [...INDEXES, SLUG_KEY]) {
        assert.ok(mysqlMigration.includes(`\`${index}\``), `mysql ${index}`);
        assert.ok(sqliteBaseline.includes(`INDEX "${index}"`), `sqlite ${index}`);
    }
    assert.ok(mysqlMigration.includes('ALTER TABLE `adventure_persona` DROP COLUMN `clan`,'), 'mysql drops clan');
    assert.ok(mysqlMigration.includes('DROP COLUMN `playstyle`,'), 'mysql drops playstyle');
    assert.ok(mysqlMigration.includes('ADD COLUMN `facing` INTEGER NOT NULL DEFAULT 0;'), 'mysql adds facing');
    const sqlitePersona = sqliteBaseline.slice(sqliteBaseline.indexOf('CREATE TABLE "adventure_persona" ('));
    const sqlitePersonaTable = sqlitePersona.slice(0, sqlitePersona.indexOf('\n);'));
    assert.ok(sqlitePersonaTable.includes('"facing" INTEGER NOT NULL DEFAULT 0'), 'sqlite facing');
    assert.ok(!/"clan"|"playstyle"/.test(sqlitePersonaTable), 'sqlite: no clan, no playstyle');
});

test('every schema has the four models, and the persona model changed', () => {
    for (const [name, schema] of Object.entries(schemas)) {
        for (const [table, columns] of Object.entries(COLUMNS)) {
            const model = modelBody(schema, table);
            for (const column of columns) {
                assert.ok(new RegExp(`^\\s+${column}\\s`, 'm').test(model), `${name}: ${table}.${column}`);
            }
        }
        assert.ok(/^\s+slug\s+String\s+@unique$/m.test(modelBody(schema, 'adventure_clan')), `${name}: slugs are unique`);
        assert.ok(modelBody(schema, 'adventure_clan_member').includes('@@index([clan_id])'), `${name}: member index`);
        assert.ok(modelBody(schema, 'adventure_clan_invite').includes('@@id([clan_id, account_id])'), `${name}: invite key`);
        assert.ok(modelBody(schema, 'adventure_clan_invite').includes('@@index([account_id])'), `${name}: invite index`);
        assert.ok(modelBody(schema, 'adventure_clan_notice').includes('@@index([clan_id, created_at])'), `${name}: notice index`);
        const persona = modelBody(schema, 'adventure_persona');
        assert.ok(/^\s+facing\s+Int\s+@default\(0\)/m.test(persona), `${name}: facing`);
        assert.ok(!/^\s+(clan|playstyle)\s/m.test(persona), `${name}: no clan, no playstyle`);
    }
});

test('the generated types know the new tables and the new persona', () => {
    for (const table of Object.keys(COLUMNS)) {
        assert.ok(types.includes(`export type ${table} = {`), `${table} type`);
        assert.ok(types.includes(`    ${table}: ${table};`), `DB.${table}`);
    }
    const persona = types.slice(types.indexOf('export type adventure_persona = {'));
    const personaType = persona.slice(0, persona.indexOf('};'));
    assert.ok(personaType.includes('facing: Generated<number>;'), 'facing');
    const notice = types.slice(types.indexOf('export type adventure_clan_notice = {'));
    assert.ok(notice.slice(0, notice.indexOf('};')).includes('deleted_at: Timestamp | null;'), 'a notice can be deleted');
    assert.ok(!/\b(clan|playstyle):/.test(personaType), 'no clan, no playstyle');
});
