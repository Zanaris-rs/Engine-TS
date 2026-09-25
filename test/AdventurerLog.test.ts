import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 13, read back from the file, and its five tables in all six
// places. The functions' behaviour is rehearsed against a real postgres
// outside this repo; what must not drift silently is pinned here, several
// items as contract - the twenty minutes, the rates, the lengths the website
// repeats - with the reason beside them.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function modelBody(schema: string, model: string): string {
    const start = schema.indexOf(`\nmodel ${model} {`);
    assert.notEqual(start, -1, `model ${model}`);
    const body = schema.slice(start);
    return body.slice(0, body.indexOf('\n}'));
}

const migration = read('../prisma/postgres/migrations/013_adventurer_log/migration.sql');
const mysqlMigration = read('../prisma/multiworld/migrations/20260924000002_adventurer_log/migration.sql');
const sqliteBaseline = read('../prisma/singleworld/migrations/20251229170623_clean/migration.sql');
const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

const ROLLBACK = '\n-- rollback:';
const MARKER = '-- === functions ===';
const live = migration.slice(0, migration.indexOf(ROLLBACK));
const rollback = migration.slice(migration.indexOf(ROLLBACK));

const COLUMNS: Record<string, string[]> = {
    adventure_log_profile: ['account_id', 'headline', 'about', 'custom_css', 'css_disabled_at', 'hidden_categories', 'updated_at'],
    adventure_update: ['account_id', 'body', 'created_at', 'deleted_at', 'staff_hidden_at'],
    adventure_reply: ['update_id', 'author_account_id', 'body', 'created_at', 'deleted_at', 'staff_hidden_at'],
    adventure_block: ['owner_account_id', 'blocked_account_id', 'created_at'],
    adventure_report: ['reporter_account_id', 'target_kind', 'target_id', 'reason', 'created_at', 'resolved_at', 'resolved_by_account_id', 'resolution', 'note']
};

const INDEXES = [
    'adventure_update_account_id_created_at_idx',
    'adventure_reply_update_id_created_at_idx',
    'adventure_reply_author_account_id_created_at_idx',
    'adventure_report_reporter_account_id_created_at_idx',
    'adventure_report_resolved_at_created_at_idx'
];

const GRANTED = [
    'adventure_log(text, text)',
    'adventure_timeline(text, text, timestamptz, int, int, int)',
    'adventure_replies(text, text, int[])',
    'adventure_log_save(text, text, text)',
    'adventure_log_set_hidden(text, int)',
    'adventure_log_save_css(text, text)',
    'adventure_update_post(text, text)',
    'adventure_update_delete(text, int)',
    'adventure_reply_post(text, int, text)',
    'adventure_reply_delete(text, int)',
    'adventure_block(text, text)',
    'adventure_unblock(text, text)',
    'adventure_blocks(text)',
    'adventure_report(text, text, int, text, text)',
    'staff_adventure_reports(text, boolean)',
    'staff_adventure_resolve(text, text, int, text, text)'
];
const HELPERS = ['adventure_text(text, int, boolean)', 'adventure_author(text, boolean)'];

test('the five tables are in every backend and every schema, with every column', () => {
    for (const [table, columns] of Object.entries(COLUMNS)) {
        assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS "${table}" (`), `postgres ${table}`);
        assert.ok(migration.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`), `RLS ${table}`);
        assert.ok(mysqlMigration.includes(`CREATE TABLE \`${table}\` (`), `mysql ${table}`);
        assert.ok(sqliteBaseline.includes(`CREATE TABLE "${table}" (`), `sqlite ${table}`);

        for (const column of columns) {
            assert.ok(migration.includes(`"${column}"`), `postgres ${table}.${column}`);
            assert.ok(mysqlMigration.includes(`\`${column}\``), `mysql ${table}.${column}`);
            assert.ok(sqliteBaseline.includes(`"${column}"`), `sqlite ${table}.${column}`);
        }

        for (const [name, schema] of Object.entries(schemas)) {
            const model = modelBody(schema, table);
            for (const column of columns) {
                assert.ok(new RegExp(`^\\s+${column}\\s`, 'm').test(model), `${name}: ${table}.${column}`);
            }
        }
    }

    for (const index of INDEXES) {
        assert.ok(migration.includes(`CREATE INDEX IF NOT EXISTS "${index}"`), `postgres ${index}`);
        assert.ok(mysqlMigration.includes(`\`${index}\``), `mysql ${index}`);
        assert.ok(sqliteBaseline.includes(`CREATE INDEX "${index}"`), `sqlite ${index}`);
    }

    const types = read('../src/db/types.ts');
    for (const table of Object.keys(COLUMNS)) {
        assert.ok(types.includes(`${table}: ${table};`), `generated type ${table}`);
    }

    assert.ok(!migration.includes('CREATE POLICY'), 'no policy');
    assert.ok(!/\bREFERENCES\b/.test(migration), 'no foreign keys');
    assert.ok(!migration.slice(0, migration.indexOf(MARKER)).includes('CREATE OR REPLACE FUNCTION'), 'no functions above the marker');
});

test('the lengths the website repeats are the ones postgres checks', () => {
    // lib/adventurer-log/format.ts on the website has the same numbers
    assert.ok(migration.includes('CHECK (length("headline") <= 80)'), 'headline');
    assert.ok(migration.includes('CHECK (length("about") <= 1000)'), 'about');
    assert.ok(migration.includes('CHECK (length("custom_css") <= 20000)'), 'css');
    assert.ok(migration.includes('CHECK (length("body") BETWEEN 1 AND 2000)'), 'update');
    assert.ok(migration.includes('CHECK (length("body") BETWEEN 1 AND 500)'), 'reply');
    assert.ok(migration.includes('CHECK (length("reason") BETWEEN 1 AND 500)'), 'report');
    assert.ok(migration.includes('CHECK ("hidden_categories" BETWEEN 0 AND 255)'), 'a bit per adventure category, 0..7');
    assert.ok(migration.includes('CHECK ("owner_account_id" <> "blocked_account_id")'), 'no blocking yourself');
    assert.ok(migration.includes('CREATE UNIQUE INDEX IF NOT EXISTS "adventure_report_one_open_key"'), 'one open report per reporter per target');
});

test('everyone else sees an adventure twenty minutes late; the owner at once', () => {
    // So a log cannot be used to follow a player around the game.
    assert.ok(live.includes("WHERE (log.is_owner OR e.occurred_at <= now() - interval '20 minutes')"), 'the delay');
    assert.ok(live.includes('AND (log.hidden & (1 << e.category)) = 0'), 'hidden categories apply to everyone');
    assert.ok(live.includes('e.profile = accounts.public_profile()'), 'the public profile only');
});

test('the rates are counted under a lock on the author', () => {
    for (const [lock, rate] of [
        ["'adventure_update:'", '>= 10 THEN'],
        ["'adventure_reply:'", '>= 30 THEN'],
        ["'adventure_report:'", '>= 10 THEN']
    ]) {
        assert.ok(live.includes(`pg_advisory_xact_lock(hashtext(${lock}`), `lock ${lock}`);
        assert.ok(live.includes(rate), `rate ${rate}`);
    }
    assert.ok(live.includes("r.created_at > now() - interval '1 day') >= 10"), 'ten reports a day');
});

test('staff resolution checks the typed password in the shared limiter, and audits', () => {
    const body = live.slice(live.indexOf('FUNCTION accounts.staff_adventure_resolve'));
    assert.ok(body.includes("accounts.throttled('resolve:' || p_actor, p_actor)"), 'limiter');
    assert.ok(body.includes('v_password <> p_candidate_hash'), 'password');
    assert.ok(body.includes('INSERT INTO public.staff_action'), 'audit');
});

test('the website gets sixteen functions and not the helpers', () => {
    const grants = live.match(/^GRANT .*/gm) ?? [];
    assert.equal(grants.length, GRANTED.length);
    for (const signature of GRANTED) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`), `revoke ${signature}`);
        assert.ok(live.includes(`GRANT EXECUTE ON FUNCTION accounts.${signature} TO website;`), `grant ${signature}`);
    }
    for (const signature of HELPERS) {
        assert.ok(live.includes(`REVOKE ALL ON FUNCTION accounts.${signature} FROM PUBLIC;`), `revoke ${signature}`);
        assert.ok(!live.includes(`ON FUNCTION accounts.${signature} TO website`), `${signature} stays internal`);
    }

    const headers = [...live.matchAll(/CREATE OR REPLACE FUNCTION accounts\.(\w+)\([\s\S]*?AS \$\$/g)];
    assert.equal(headers.length, GRANTED.length + HELPERS.length);
    for (const header of headers) {
        assert.ok(header[0].includes('SECURITY DEFINER SET search_path = public, pg_temp'), header[1]);
    }
});

test('the rollback drops every function and table', () => {
    for (const signature of [...GRANTED, ...HELPERS]) {
        assert.ok(rollback.includes(`-- DROP FUNCTION IF EXISTS accounts.${signature};`), `drop ${signature}`);
    }
    for (const table of Object.keys(COLUMNS)) {
        assert.ok(rollback.includes(`-- DROP TABLE IF EXISTS "${table}";`), `drop ${table}`);
    }
});
