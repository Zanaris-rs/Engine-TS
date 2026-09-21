import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 8's two tables have to say the same thing in five places: the
// postgres migration that creates them, the mysql migration that mirrors it,
// the sqlite baseline (edited in place, see the README), and the three Prisma
// schemas the generated types come from. Same reasoning as
// InviteSchema.test.ts. Only postgres runs the functions, but every backend
// carries the tables, as it does for login_attempt and invite_attempt.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function modelBody(schema: string, model: string): string {
    const start = schema.indexOf(`\nmodel ${model} {`);
    assert.notEqual(start, -1, `model ${model}`);

    const body = schema.slice(start);
    return body.slice(0, body.indexOf('\n}'));
}

const postgresMigration = read('../prisma/postgres/migrations/8_records/migration.sql');
const mysqlMigration = read('../prisma/multiworld/migrations/20260921000000_records/migration.sql');
const sqliteBaseline = read('../prisma/singleworld/migrations/20251229170623_clean/migration.sql');

const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

const TABLES = ['record_attempt', 'record_attempt_skill'];

const COLUMNS: Record<string, string[]> = {
    record_attempt: ['account_id', 'profile', 'duration_seconds', 'state', 'reason', 'initial_logout_at', 'started_at', 'final_logout_at', 'stopped_at', 'elapsed_ms'],
    record_attempt_skill: ['attempt_id', 'category', 'start_xp', 'end_xp', 'gained']
};

const INDEXES = ['record_attempt_account_id_started_at_idx', 'record_attempt_profile_duration_seconds_state_idx', 'record_attempt_skill_category_gained_idx'];

const MARKER = '-- === functions ===';

test('the postgres migration creates both tables, with RLS on and no policy', () => {
    for (const table of TABLES) {
        assert.ok(postgresMigration.includes(`CREATE TABLE IF NOT EXISTS "${table}" (`), `CREATE TABLE ${table}`);
        assert.ok(postgresMigration.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`), `RLS ${table}`);
    }

    assert.ok(!postgresMigration.includes('CREATE POLICY'), 'no policies');
    assert.ok(!/\bREFERENCES\b/.test(postgresMigration), 'no foreign keys, like every other table');

    for (const grant of postgresMigration.match(/^GRANT .*/gm) ?? []) {
        assert.ok(grant.includes('ON FUNCTION'), grant);
    }
});

test('postgres alone enforces one running attempt per account', () => {
    // Prisma cannot declare a partial index and mysql has none, so this lives
    // only in the postgres migration - which is the only backend that runs the
    // functions relying on it.
    assert.ok(
        postgresMigration.includes('CREATE UNIQUE INDEX IF NOT EXISTS "record_attempt_one_running_key" ON "record_attempt"("account_id") WHERE "state" = \'running\';'),
        'partial unique index'
    );
});

test('the state, the reasons and the measurement are checked in postgres', () => {
    assert.ok(postgresMigration.includes('CHECK ("state" IN (\'running\', \'valid\', \'rejected\', \'void\', \'abandoned\'))'), 'states');
    assert.ok(postgresMigration.includes('CHECK ("reason" IS NULL OR "reason" IN (\'over_time\', \'no_session\', \'no_clean_logout\', \'player\', \'not_stopped\'))'), 'reasons');
    assert.ok(postgresMigration.includes('CHECK (("state" = \'running\') = ("stopped_at" IS NULL))'), 'stopped exactly when not running');
    assert.ok(postgresMigration.includes('CHECK (("final_logout_at" IS NULL) = ("elapsed_ms" IS NULL))'), 'measured together');
    assert.ok(postgresMigration.includes('CHECK ("category" BETWEEN 0 AND 21)'), 'hiscore types');
    assert.ok(postgresMigration.includes('CHECK ("gained" IS NULL OR "gained" = "end_xp" - "start_xp")'), 'the arithmetic, at rest');
});

test('every index exists in all three migrations', () => {
    for (const index of INDEXES) {
        assert.ok(postgresMigration.includes(`CREATE INDEX IF NOT EXISTS "${index}"`), `postgres ${index}`);
        assert.ok(mysqlMigration.includes(`\`${index}\``), `mysql ${index}`);
        assert.ok(sqliteBaseline.includes(`CREATE INDEX "${index}"`), `sqlite ${index}`);
    }
});

test('the mysql migration and the sqlite baseline carry both tables and every column', () => {
    for (const table of TABLES) {
        assert.ok(mysqlMigration.includes(`CREATE TABLE \`${table}\` (`), `mysql ${table}`);
        assert.ok(sqliteBaseline.includes(`CREATE TABLE "${table}" (`), `sqlite ${table}`);

        for (const column of COLUMNS[table]) {
            assert.ok(postgresMigration.includes(`"${column}"`), `postgres ${table}.${column}`);
            assert.ok(mysqlMigration.includes(`\`${column}\``), `mysql ${table}.${column}`);
            assert.ok(sqliteBaseline.includes(`"${column}"`), `sqlite ${table}.${column}`);
        }
    }

    assert.ok(mysqlMigration.includes('PRIMARY KEY (`attempt_id`, `category`)'), 'mysql skill key');
    assert.ok(sqliteBaseline.includes('PRIMARY KEY ("attempt_id", "category")'), 'sqlite skill key');
});

test('all three Prisma schemas declare both models with every column', () => {
    for (const [name, schema] of Object.entries(schemas)) {
        for (const table of TABLES) {
            const model = modelBody(schema, table);
            for (const column of COLUMNS[table]) {
                assert.ok(new RegExp(`^\\s+${column}\\s`, 'm').test(model), `${name}: ${table}.${column}`);
            }
        }

        const attempt = modelBody(schema, 'record_attempt');
        assert.ok(attempt.includes('@@index([account_id, started_at(sort: Desc)])'), `${name}: history index`);
        assert.ok(attempt.includes('@@index([profile, duration_seconds, state])'), `${name}: board index`);

        const skill = modelBody(schema, 'record_attempt_skill');
        assert.ok(skill.includes('@@id([attempt_id, category])'), `${name}: skill key`);
        assert.ok(skill.includes('@@index([category, gained(sort: Desc)])'), `${name}: skill index`);
    }
});

test('the generated types know the new tables', () => {
    const types = read('../src/db/types.ts');
    assert.ok(types.includes('export type record_attempt = {'), 'record_attempt type');
    assert.ok(types.includes('export type record_attempt_skill = {'), 'record_attempt_skill type');
    assert.ok(types.includes('record_attempt: record_attempt;'), 'DB.record_attempt');
    assert.ok(types.includes('record_attempt_skill: record_attempt_skill;'), 'DB.record_attempt_skill');
});

test('the DDL half defines no function', () => {
    assert.ok(postgresMigration.includes(MARKER), 'marker');
    const ddl = postgresMigration.slice(0, postgresMigration.indexOf(MARKER));
    assert.ok(!ddl.includes('CREATE OR REPLACE FUNCTION'), 'no functions above the marker');
});
