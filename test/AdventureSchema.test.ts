import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Migration 11's two tables say the same thing in six places: the postgres
// migration, the mysql migration that mirrors it, the sqlite baseline (edited
// in place, see the README), and the three Prisma schemas the generated types
// come from. Unlike migration 8's tables every backend *writes* these - the
// login server stores the Adventurer Log through Kysely on all three - so a
// column missing from one is a crash on that backend, not just drift.

function read(path: string): string {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function modelBody(schema: string, model: string): string {
    const start = schema.indexOf(`\nmodel ${model} {`);
    assert.notEqual(start, -1, `model ${model}`);

    const body = schema.slice(start);
    return body.slice(0, body.indexOf('\n}'));
}

const postgresMigration = read('../prisma/postgres/migrations/011_adventure_capture/migration.sql');
const mysqlMigration = read('../prisma/multiworld/migrations/20260924000000_adventure_capture/migration.sql');
const sqliteBaseline = read('../prisma/singleworld/migrations/20251229170623_clean/migration.sql');

const schemas = {
    postgres: read('../prisma/postgres/schema.prisma'),
    singleworld: read('../prisma/singleworld/schema.prisma'),
    multiworld: read('../prisma/multiworld/schema.prisma')
};

const COLUMNS: Record<string, string[]> = {
    adventure_event: ['account_id', 'profile', 'session_uuid', 'seq', 'occurred_at', 'category', 'event'],
    account_look: ['account_id', 'profile', 'gender', 'kits', 'colours', 'worn', 'updated_at']
};

const INDEXES = ['adventure_event_account_id_profile_occurred_at_idx'];
const UNIQUE = 'adventure_event_session_uuid_seq_key';

test('the postgres migration creates both tables, RLS on, no policy, no function', () => {
    for (const table of Object.keys(COLUMNS)) {
        assert.ok(postgresMigration.includes(`CREATE TABLE IF NOT EXISTS "${table}" (`), `CREATE TABLE ${table}`);
        assert.ok(postgresMigration.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`), `RLS ${table}`);
    }

    assert.ok(!postgresMigration.includes('CREATE POLICY'), 'no policies');
    assert.ok(!/\bREFERENCES\b/.test(postgresMigration), 'no foreign keys, like every other table');
    assert.ok(!postgresMigration.includes('CREATE OR REPLACE FUNCTION'), 'the website reads these through later migrations');
    assert.ok(!/^GRANT /m.test(postgresMigration), 'nothing granted: the website has no business with the raw tables');
});

test('a retried logout stores its lines once: (session_uuid, seq) is unique everywhere', () => {
    assert.ok(postgresMigration.includes(`CREATE UNIQUE INDEX IF NOT EXISTS "${UNIQUE}" ON "adventure_event"("session_uuid", "seq");`), 'postgres');
    assert.ok(mysqlMigration.includes(`UNIQUE INDEX \`${UNIQUE}\`(\`session_uuid\`, \`seq\`)`), 'mysql');
    assert.ok(sqliteBaseline.includes(`CREATE UNIQUE INDEX "${UNIQUE}" ON "adventure_event"("session_uuid", "seq");`), 'sqlite');

    for (const [name, schema] of Object.entries(schemas)) {
        assert.ok(modelBody(schema, 'adventure_event').includes('@@unique([session_uuid, seq])'), name);
    }
});

test('postgres checks the category, the seq, the length and the gender', () => {
    assert.ok(postgresMigration.includes('CHECK ("category" BETWEEN 0 AND 7)'), 'categories 0..7, Adventure.ts');
    assert.ok(postgresMigration.includes('CHECK ("seq" >= 0)'), 'seq');
    // 191: mysql's default VARCHAR, which the engine cuts every line to
    assert.ok(postgresMigration.includes('CHECK (length("event") BETWEEN 1 AND 191)'), 'length');
    assert.ok(postgresMigration.includes('CHECK ("gender" IN (0, 1))'), 'gender');
});

test('every index exists in all three migrations', () => {
    for (const index of INDEXES) {
        assert.ok(postgresMigration.includes(`CREATE INDEX IF NOT EXISTS "${index}"`), `postgres ${index}`);
        assert.ok(mysqlMigration.includes(`\`${index}\``), `mysql ${index}`);
        assert.ok(sqliteBaseline.includes(`CREATE INDEX "${index}"`), `sqlite ${index}`);
    }
});

test('the mysql migration and the sqlite baseline carry both tables and every column', () => {
    for (const [table, columns] of Object.entries(COLUMNS)) {
        assert.ok(mysqlMigration.includes(`CREATE TABLE \`${table}\` (`), `mysql ${table}`);
        assert.ok(sqliteBaseline.includes(`CREATE TABLE "${table}" (`), `sqlite ${table}`);

        for (const column of columns) {
            assert.ok(postgresMigration.includes(`"${column}"`), `postgres ${table}.${column}`);
            assert.ok(mysqlMigration.includes(`\`${column}\``), `mysql ${table}.${column}`);
            assert.ok(sqliteBaseline.includes(`"${column}"`), `sqlite ${table}.${column}`);
        }
    }

    assert.ok(mysqlMigration.includes('PRIMARY KEY (`account_id`, `profile`)'), 'mysql look key');
    assert.ok(sqliteBaseline.includes('PRIMARY KEY ("account_id", "profile")'), 'sqlite look key');
    assert.ok(postgresMigration.includes('PRIMARY KEY ("account_id", "profile")'), 'postgres look key');
});

test('all three Prisma schemas declare both models with every column', () => {
    for (const [name, schema] of Object.entries(schemas)) {
        for (const [table, columns] of Object.entries(COLUMNS)) {
            const model = modelBody(schema, table);
            for (const column of columns) {
                assert.ok(new RegExp(`^\\s+${column}\\s`, 'm').test(model), `${name}: ${table}.${column}`);
            }
        }

        assert.ok(modelBody(schema, 'adventure_event').includes('@@index([account_id, profile, occurred_at(sort: Desc)])'), `${name}: timeline index`);
        assert.ok(modelBody(schema, 'account_look').includes('@@id([account_id, profile])'), `${name}: look key`);
    }
});

test('the generated types know the new tables', () => {
    const types = read('../src/db/types.ts');
    assert.ok(types.includes('export type adventure_event = {'), 'adventure_event type');
    assert.ok(types.includes('export type account_look = {'), 'account_look type');
    assert.ok(types.includes('adventure_event: adventure_event;'), 'DB.adventure_event');
    assert.ok(types.includes('account_look: account_look;'), 'DB.account_look');
});
